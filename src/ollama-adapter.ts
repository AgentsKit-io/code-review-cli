import type { AdapterFactory, AdapterRequest, StreamChunk, StreamSource } from "@agentskit/core";

export interface OllamaReviewOptions {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_OLLAMA_TIMEOUT_MS = 30_000;

function parseArguments(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return {};
  }
}

function providerMessages(request: AdapterRequest): Array<Record<string, unknown>> {
  const toolNames = new Map<string, string>();
  const messages: Array<Record<string, unknown>> = [];
  if (request.context?.systemPrompt) {
    messages.push({ role: "system", content: request.context.systemPrompt });
  }

  for (const message of request.messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const call of message.toolCalls) toolNames.set(call.id, call.name);
      messages.push({
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: parseArguments(call.args) },
        })),
      });
      continue;
    }
    if (message.role === "tool") {
      const toolName = message.toolCallId ? toolNames.get(message.toolCallId) : undefined;
      const onlyRequestedTool = request.context?.tools?.length === 1 ? request.context.tools[0]?.name : undefined;
      const resolvedToolName = toolName ?? onlyRequestedTool;
      messages.push({
        role: "tool",
        content: message.content,
        ...(resolvedToolName ? { tool_name: resolvedToolName } : {}),
      });
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }

  return messages;
}

function providerTools(request: AdapterRequest) {
  return (request.context?.tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.schema,
    },
  }));
}

async function* parseResponse(response: Response): AsyncIterableIterator<StreamChunk> {
  if (!response.ok) {
    const detail = (await response.text()).trim();
    yield { type: "error", content: `Ollama API returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}` };
    return;
  }
  if (!response.body) {
    yield { type: "error", content: "Ollama API returned an empty response body" };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let toolCallIndex = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : (lines.pop() ?? "");

      for (const line of lines) {
        if (!line.trim()) continue;
        let event: {
          message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        try {
          event = JSON.parse(line) as typeof event;
        } catch {
          continue;
        }

        if (event.message?.content) yield { type: "text", content: event.message.content };
        for (const call of event.message?.tool_calls ?? []) {
          if (!call.function?.name) continue;
          yield {
            type: "tool_call",
            toolCall: {
              id: call.id ?? `${call.function.name}-${toolCallIndex++}`,
              name: call.function.name,
              args: typeof call.function.arguments === "string"
                ? call.function.arguments
                : JSON.stringify(call.function.arguments ?? {}),
            },
          };
        }
        if (event.done) {
          if (typeof event.prompt_eval_count === "number" || typeof event.eval_count === "number") {
            const promptTokens = event.prompt_eval_count ?? 0;
            const completionTokens = event.eval_count ?? 0;
            yield { type: "usage", usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } };
          }
          yield { type: "done" };
          return;
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: "done" };
}

export function ollamaReview(options: OllamaReviewOptions): AdapterFactory {
  const baseUrl = (options.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;

  return {
    capabilities: { streaming: true, tools: true, structuredOutput: true },
    createSource: (request: AdapterRequest): StreamSource => {
      const controller = new AbortController();
      return {
        stream: async function* () {
          try {
            const tools = providerTools(request);
            const response = await fetch(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: options.model,
                stream: true,
                messages: providerMessages(request),
                ...(tools.length > 0 ? { tools } : {}),
              }),
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
            });
            yield* parseResponse(response);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            yield { type: "error", content: `Ollama API request failed: ${message}` };
          }
        },
        abort: () => controller.abort(),
      };
    },
  };
}

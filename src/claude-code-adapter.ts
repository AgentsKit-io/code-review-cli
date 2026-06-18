/**
 * AgentsKit adapter backed by the local `claude -p` (Claude Code headless) — no
 * ANTHROPIC_API_KEY needed; uses your logged-in CLI. `claude -p` is an agent, not a
 * raw model API, so this adapter is tuned for the promote pipeline's pattern: each
 * stage offers exactly ONE tool, so we tell Claude to emit only that tool's JSON
 * args and synthesize the `tool_call` stream chunk the runtime expects.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterFactory, AdapterRequest, StreamChunk, StreamSource } from "@agentskit/core";

const run = promisify(execFile);

/**
 * Pull the JSON object out of a model reply: first `{` to last `}` over the whole
 * output. Robust to ```json fences AND to ``` code fences *inside* the JSON body
 * (the outer object's braces are still the first/last in the string).
 */
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON object in claude output:\n${text.slice(0, 400)}`);
  }
  return text.slice(start, end + 1);
}

export function claudeCode(opts: { model?: string } = {}): AdapterFactory {
  return {
    capabilities: { streaming: false, tools: true, structuredOutput: true },
    createSource: (request: AdapterRequest): StreamSource => ({
      stream: async function* (): AsyncIterableIterator<StreamChunk> {
        try {
          const system = request.messages.find((m) => m.role === "system")?.content ?? "";
          const convo = request.messages
            .filter((m) => m.role !== "system")
            .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
            .join("\n\n");
          const tools = request.context?.tools ?? [];

          let prompt = `${system}\n\n${convo}`;
          if (tools.length === 1) {
            const t = tools[0]!;
            prompt += `\n\nReturn ONLY a JSON object that is the argument to the "${t.name}" tool, matching this JSON Schema exactly. No prose, no code fences:\n${JSON.stringify(t.schema)}`;
          }

          const args = ["-p", prompt];
          if (opts.model) args.push("--model", opts.model);
          const { stdout } = await run("claude", args, { maxBuffer: 20 * 1024 * 1024 });
          const out = stdout.trim();

          if (tools.length === 1) {
            yield { type: "tool_call", toolCall: { id: `tc-${Date.now()}`, name: tools[0]!.name, args: extractJson(out) } };
          } else {
            yield { type: "text", content: out };
          }
          yield { type: "done" };
        } catch (err) {
          yield { type: "error", content: err instanceof Error ? err.message : String(err) };
        }
      },
      abort: () => {},
    }),
  };
}

/**
 * AgentsKit adapter backed by the local `claude -p` (Claude Code headless) — no
 * ANTHROPIC_API_KEY needed; uses your logged-in CLI. `claude -p` is an agent, not a
 * raw model API, so this adapter is tuned for the promote pipeline's pattern: each
 * stage offers exactly ONE tool, so we tell Claude to emit only that tool's JSON
 * args and synthesize the `tool_call` stream chunk the runtime expects.
 */
import type { AdapterFactory, AdapterRequest, StreamChunk, StreamSource } from "@agentskit/core";
import { runLocalCli, type LocalCliMode } from "./local-cli-process.js";

/**
 * Run `claude` and capture stdout. Crucially we CLOSE the child's stdin: in a
 * non-TTY env (CI / self-hosted runner) `claude -p` otherwise blocks waiting for
 * stdin ("no stdin data received in 3s …") and fails. Locally stdin is a TTY so it
 * never showed. stderr is attached to the error for diagnosis.
 */
async function runClaude(args: string[], signal?: AbortSignal, mode?: LocalCliMode, worker?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<string> {
  // Run from HOME (a trusted dir): the runner's checkout dir is untrusted and can
  // make claude exit without output (folder-trust). The file under review is in the
  // prompt, not read from cwd, so cwd is irrelevant to the result.
  const { stdout } = await runLocalCli("claude", args, { signal, mode, ...worker });
  return stdout;
}

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

export function claudeCode(opts: { model?: string; mode?: LocalCliMode; worker?: { timeoutMs?: number; maxOutputBytes?: number } } = {}): AdapterFactory {
  return {
    capabilities: { streaming: false, tools: true, structuredOutput: true },
    createSource: (request: AdapterRequest): StreamSource => {
      const controller = new AbortController();
      return {
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
          const out = (await runClaude(args, controller.signal, opts.mode, opts.worker)).trim();

          if (tools.length === 1) {
            yield { type: "tool_call", toolCall: { id: `tc-${Date.now()}`, name: tools[0]!.name, args: extractJson(out) } };
          } else {
            yield { type: "text", content: out };
          }
          yield { type: "done" };
        } catch (err) {
          // Surface claude's own stderr/stdout (e.g. "Not logged in · Please run
          // /login"). The default execFile message embeds the whole prompt — drop it.
          const e = err as { code?: string; message?: string; stderr?: string; stdout?: string };
          const detail = e.code === "ETIMEDOUT" ? e.message : [e.stderr, e.stdout].filter(Boolean).join(" ").trim();
          yield { type: "error", content: `claude -p failed${detail ? `: ${detail.slice(0, 400)}` : ` (no output): ${(e.message ?? "").split("\n")[0]}`}` };
        }
      },
      abort: () => controller.abort(),
      };
    },
  };
}

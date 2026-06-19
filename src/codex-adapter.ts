/**
 * AgentsKit adapter backed by the local OpenAI **Codex CLI** (`codex exec`) — the
 * codex equivalent of the claude -p adapter. Uses your logged-in Codex session
 * (ChatGPT subscription), no OPENAI_API_KEY, no per-call API cost. Headless: the
 * prompt goes in as an arg, the final message is written to a temp file via
 * `-o`, sandbox is read-only (the agent only emits JSON, runs no tools).
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterFactory, AdapterRequest, StreamChunk, StreamSource } from "@agentskit/core";

/** Pull the JSON object out of a reply: first `{` to last `}` over the whole output. */
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON object in codex output:\n${text.slice(0, 400)}`);
  }
  return text.slice(start, end + 1);
}

/** Run `codex exec` and return its final message (captured via -o). */
function runCodex(prompt: string, model?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "cr-codex-"));
    const outFile = join(dir, "out.txt");
    const args = [
      "exec",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "-C",
      process.env.HOME ?? process.cwd(),
      "-o",
      outFile,
    ];
    if (model) args.push("-m", model);
    args.push(prompt);
    const child = execFile("codex", args, { maxBuffer: 20 * 1024 * 1024 }, (err, _stdout, stderr) => {
      let message = "";
      try {
        message = readFileSync(outFile, "utf8");
      } catch {
        /* no output file */
      }
      rmSync(dir, { recursive: true, force: true });
      if (message.trim()) return resolve(message);
      const e = (err ?? new Error("codex produced no output")) as { stderr?: string; stdout?: string };
      e.stderr = stderr;
      e.stdout = _stdout;
      reject(e);
    });
    child.stdin?.end(); // headless: don't let codex wait on stdin
  });
}

export function codexCli(opts: { model?: string } = {}): AdapterFactory {
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

          const out = (await runCodex(prompt, opts.model)).trim();

          if (tools.length === 1) {
            yield { type: "tool_call", toolCall: { id: `tc-${Date.now()}`, name: tools[0]!.name, args: extractJson(out) } };
          } else {
            yield { type: "text", content: out };
          }
          yield { type: "done" };
        } catch (err) {
          const e = err as { message?: string; stderr?: string; stdout?: string };
          const detail = [e.stderr, e.stdout].filter(Boolean).join(" ").trim();
          yield { type: "error", content: `codex exec failed${detail ? `: ${detail.slice(0, 400)}` : ` (no output): ${(e.message ?? "").split("\n")[0]}`}` };
        }
      },
      abort: () => {},
    }),
  };
}

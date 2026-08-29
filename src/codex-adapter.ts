/**
 * AgentsKit adapter backed by the local OpenAI **Codex CLI** (`codex exec`) — the
 * codex equivalent of the claude -p adapter. Uses your logged-in Codex session
 * (ChatGPT subscription), no OPENAI_API_KEY, no per-call API cost. Headless: the
 * prompt goes in as an arg, the final message is written to a temp file via
 * `-o`, sandbox is read-only (the agent only emits JSON, runs no tools).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterFactory, AdapterRequest, StreamChunk, StreamSource } from "@agentskit/core";
import { runLocalCli, type LocalCliMode } from "./local-cli-process.js";

/**
 * Pull a JSON object out of a reply while rejecting prose/braces that are not
 * part of the response. Codex is also constrained with --output-schema below,
 * but this fallback tolerates wrapper text in the captured output.
 */
function extractJson(text: string): string {
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  if (fenced) candidates.push(fenced.trim());

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end >= start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return JSON.stringify(value);
      }
    } catch {
      // Try the next bounded candidate and report only a safe summary below.
    }
  }
  throw new Error(`codex output was not a JSON object (${text.length} characters)`);
}

/** Run `codex exec` and return its final message (captured via -o). */
async function runCodex(prompt: string, schema: unknown, model?: string, signal?: AbortSignal, mode?: LocalCliMode, worker?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "cr-codex-"));
  const outFile = join(dir, "out.txt");
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-o",
    outFile,
  ];
  if (schema !== undefined) {
    const schemaFile = join(dir, "output-schema.json");
    const serializedSchema = JSON.stringify(schema);
    if (serializedSchema === undefined) throw new Error("codex output schema could not be serialized");
    writeFileSync(schemaFile, serializedSchema, { encoding: "utf8", mode: 0o600 });
    args.push("--output-schema", schemaFile);
  }
  if (model) args.push("-m", model);
  args.push(prompt);

  try {
    await runLocalCli("codex", args, { signal, mode, ...worker });
    return readFileSync(outFile, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function codexCli(opts: { model?: string; mode?: LocalCliMode; worker?: { timeoutMs?: number; maxOutputBytes?: number } } = {}): AdapterFactory {
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

          const schema = tools.length === 1 ? tools[0]!.schema : undefined;
          const out = (await runCodex(prompt, schema, opts.model, controller.signal, opts.mode, opts.worker)).trim();

          if (tools.length === 1) {
            yield { type: "tool_call", toolCall: { id: `tc-${Date.now()}`, name: tools[0]!.name, args: extractJson(out) } };
          } else {
            yield { type: "text", content: out };
          }
          yield { type: "done" };
        } catch (err) {
          const e = err as { code?: string; message?: string; stderr?: string; stdout?: string };
          const detail = e.code === "ETIMEDOUT" ? e.message : [e.stderr, e.stdout].filter(Boolean).join(" ").trim();
          yield { type: "error", content: `codex exec failed${detail ? `: ${detail.slice(0, 400)}` : ` (no output): ${(e.message ?? "").split("\n")[0]}`}` };
        }
      },
      abort: () => controller.abort(),
      };
    },
  };
}

import { execFile } from 'node:child_process'
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { extname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import type { ReviewTarget } from './agent.js'
import { redactSecrets } from '../../src/local-cli-process.js'

const run = promisify(execFile)
const DEFAULT_SNAPSHOT_FILES = 100
const DEFAULT_TOTAL_BYTES = 5 * 1024 * 1024
const DEFAULT_PROMPT_FILE_BYTES = 256 * 1024
const ABSOLUTE_SNAPSHOT_FILES = 500
const ABSOLUTE_TOTAL_BYTES = 25 * 1024 * 1024
const ABSOLUTE_PROMPT_FILE_BYTES = 1024 * 1024

export type ContextMode = 'prompt' | 'isolated-snapshot'
export interface SourceLimits {
  readonly maxFiles?: number
  readonly maxBytes?: number
  readonly maxFileBytes?: number
}

export type SourceConfig =
  | { kind: 'git-diff'; base: string; head?: string; cwd?: string; redact?: boolean; limits?: SourceLimits }
  | { kind: 'github-pr'; owner: string; repo: string; number: number; token: string; redact?: boolean; limits?: SourceLimits }
  | { kind: 'paths'; paths: string[]; cwd?: string; redact?: boolean; limits?: SourceLimits }
  | { kind: 'stdin'; content: string; filename?: string; redact?: boolean; limits?: SourceLimits }
  | { kind: 'isolated-snapshot'; cwd: string; patterns: string[]; redact?: boolean; limits?: SourceLimits }

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.c', '.h', '.cpp', '.hpp',
  '.swift', '.scala', '.sql', '.sh', '.vue', '.svelte', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml',
  '.graphql', '.gql', '.tf', '.tfvars', '.hcl',
])
const SPECIAL_FILES = new Set(['Dockerfile', 'Containerfile', 'Makefile', 'Jenkinsfile', 'Procfile', ' justfile '].map((name) => name.trim()))
const DENY_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', 'out', 'vendor'])
const DENY_FILE = /^(?:\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|.*\.(?:key|pem|crt|cer|p12|pfx))$/i

const langOf = (file: string): string => {
  const base = file.split('/').pop() ?? file
  if (SPECIAL_FILES.has(base) || base.startsWith('.github/')) return base.toLowerCase().includes('docker') ? 'dockerfile' : 'config'
  return extname(file).replace('.', '') || 'text'
}

function normalize(file: string): string { return file.replaceAll('\\', '/') }

function deniedPath(file: string): string | undefined {
  const parts = normalize(file).split('/')
  if (parts.some((part) => DENY_DIRS.has(part))) return 'sensitive or generated directory'
  if (DENY_FILE.test(parts.at(-1) ?? '')) return 'sensitive file'
  return undefined
}

function isReviewableName(file: string): boolean {
  const base = file.split('/').pop() ?? file
  return SPECIAL_FILES.has(base) || CODE_EXT.has(extname(file).toLowerCase()) || normalize(file).startsWith('.github/workflows/')
}

function changedRanges(patch: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const m of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]); const count = m[2] === undefined ? 1 : Number(m[2])
    if (count > 0) ranges.push({ start, end: start + count - 1 })
  }
  return ranges
}

function unreviewed(file: string, reason: string): ReviewTarget {
  return { file: normalize(file), language: langOf(file), fullContent: '', isChanged: true, reviewStatus: 'UNREVIEWED', unreviewedReason: reason }
}

function readTarget(file: string, cwd: string, limits: SourceLimits, redact: boolean, changed?: ReviewTarget['changedRanges']): ReviewTarget {
  const normalized = normalize(file)
  const denied = deniedPath(normalized)
  if (denied) return unreviewed(normalized, denied)
  if (!isReviewableName(normalized)) return unreviewed(normalized, 'unsupported text format')
  const abs = join(cwd, normalized)
  let fd: number
  try { fd = openSync(abs, 'r') } catch { return unreviewed(normalized, 'file unavailable') }
  try {
    const size = fstatSync(fd).size
    const maxFileBytes = limits.maxFileBytes ?? DEFAULT_PROMPT_FILE_BYTES
    if (size > maxFileBytes) return unreviewed(normalized, `file exceeds ${maxFileBytes} byte limit`)
    const fullContent = readFileSync(fd, 'utf8')
    if (fullContent.includes('\0')) return unreviewed(normalized, 'binary content')
    return { file: normalized, language: langOf(normalized), fullContent: redact ? redactSecrets(fullContent) : fullContent, changedRanges: changed, isChanged: Boolean(changed) }
  } catch { return unreviewed(normalized, 'file is not readable text')
  } finally { closeSync(fd) }
}

function withinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function globRegex(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; continue }
      out += '.*'; i++; continue
    }
    if (char === '*') { out += '[^/]*'; continue }
    if (char === '?') { out += '[^/]'; continue }
    out += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
  }
  return new RegExp(`${out}$`)
}

function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globRegex(normalize(pattern.replace(/^!/, ''))).test(file))
}

function validatePatterns(patterns: readonly string[]): void {
  if (!patterns.length) throw new Error('isolated-snapshot needs at least one context pattern')
  for (const pattern of patterns) {
    const value = pattern.replace(/^!/, '')
    if (!value || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value) || value.split('/').includes('..')) {
      throw new Error(`invalid context pattern "${pattern}": use a repository-relative pattern without .. traversal`)
    }
  }
}

function walkFiles(root: string, current: string, out: string[], unreviewedFiles: ReviewTarget[]): void {
  for (const entry of readdirSync(current)) {
    const abs = join(current, entry)
    const rel = normalize(relative(root, abs))
    if (DENY_DIRS.has(entry)) continue
    let stat
    try { stat = lstatSync(abs) } catch { continue }
    if (stat.isSymbolicLink()) {
      let target: string
      try { target = realpathSync(abs) } catch { unreviewedFiles.push(unreviewed(rel, 'broken symlink')); continue }
      if (!withinRoot(root, target)) unreviewedFiles.push(unreviewed(rel, 'symlink escapes repository root'))
      continue
    }
    if (stat.isDirectory()) walkFiles(root, abs, out, unreviewedFiles)
    else out.push(rel)
  }
}

async function fromGitDiff(c: Extract<SourceConfig, { kind: 'git-diff' }>): Promise<ReviewTarget[]> {
  const cwd = c.cwd ?? process.cwd(); const head = c.head ?? 'HEAD'
  const git = async (args: string[]) => (await run('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout
  const diff = await git(['diff', '--unified=0', `${c.base}...${head}`])
  const targets: ReviewTarget[] = []
  for (const block of diff.split(/^diff --git /m).slice(1)) {
    const pathMatch = block.match(/^a\/(.+?) b\/(.+)$/m); const file = pathMatch?.[2]
    if (!file || block.includes('\ndeleted file mode')) continue
    const target = readTarget(file, cwd, { maxFileBytes: c.limits?.maxFileBytes }, Boolean(c.redact), changedRanges(block))
    targets.push(target)
  }
  return targets
}

async function fromGithubPr(c: Extract<SourceConfig, { kind: 'github-pr' }>): Promise<ReviewTarget[]> {
  const api = async <T>(path: string): Promise<T> => {
    const res = await fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${c.token}`, accept: 'application/vnd.github+json', 'user-agent': 'agentskit-code-review' } })
    if (!res.ok) throw new Error(`GitHub ${path} → ${res.status}`)
    return res.json() as Promise<T>
  }
  const pr = await api<{ head: { sha: string } }>(`/repos/${c.owner}/${c.repo}/pulls/${c.number}`); const sha = pr.head.sha
  const files: Array<{ filename: string; patch?: string; status: string }> = []
  for (let page = 1; ; page++) { const batch = await api<typeof files>(`/repos/${c.owner}/${c.repo}/pulls/${c.number}/files?per_page=100&page=${page}`); files.push(...batch); if (batch.length < 100) break }
  const targets: ReviewTarget[] = []
  for (const f of files) {
    if (f.status === 'removed') continue
    const denied = deniedPath(f.filename)
    if (denied || !isReviewableName(f.filename)) { targets.push(unreviewed(f.filename, denied ?? 'unsupported text format')); continue }
    const content = await api<{ content: string; encoding: string }>(`/repos/${c.owner}/${c.repo}/contents/${encodeURIComponent(f.filename)}?ref=${sha}`)
    const raw = Buffer.from(content.content, content.encoding as BufferEncoding).toString('utf8')
    const size = Buffer.byteLength(raw, 'utf8'); const limit = c.limits?.maxFileBytes ?? DEFAULT_PROMPT_FILE_BYTES
    if (size > limit || raw.includes('\0')) { targets.push(unreviewed(f.filename, size > limit ? `file exceeds ${limit} byte limit` : 'binary content')); continue }
    targets.push({ file: f.filename, language: langOf(f.filename), fullContent: c.redact ? redactSecrets(raw) : raw, changedRanges: f.patch ? changedRanges(f.patch) : [], isChanged: true, commitId: sha })
  }
  return targets
}

function fromPaths(c: Extract<SourceConfig, { kind: 'paths' }>): ReviewTarget[] {
  const cwd = c.cwd ?? process.cwd(); const files: string[] = []; const skipped: ReviewTarget[] = []
  for (const p of c.paths) {
    const abs = join(cwd, p); const stat = lstatSync(abs)
    if (stat.isSymbolicLink()) {
      try {
        if (!withinRoot(realpathSync(cwd), realpathSync(abs))) skipped.push(unreviewed(p, 'symlink escapes repository root'))
        else files.push(normalize(p))
      } catch { skipped.push(unreviewed(p, 'broken symlink')) }
      continue
    }
    if (stat.isDirectory()) walkFiles(cwd, abs, files, skipped)
    else files.push(normalize(p))
  }
  return [...skipped, ...files.map((file) => readTarget(file, cwd, { maxFileBytes: c.limits?.maxFileBytes }, Boolean(c.redact)))]
}

function fromSnapshot(c: Extract<SourceConfig, { kind: 'isolated-snapshot' }>): ReviewTarget[] {
  validatePatterns(c.patterns)
  const root = realpathSync(c.cwd); const files: string[] = []; const skipped: ReviewTarget[] = []
  walkFiles(root, root, files, skipped)
  const includes = c.patterns.filter((pattern) => !pattern.startsWith('!')); const excludes = c.patterns.filter((pattern) => pattern.startsWith('!'))
  const selected = files.filter((file) => matchesAny(file, includes) && !matchesAny(file, excludes)).sort()
  const maxFiles = Math.min(c.limits?.maxFiles ?? DEFAULT_SNAPSHOT_FILES, ABSOLUTE_SNAPSHOT_FILES)
  const targets = selected.slice(0, maxFiles).map((file) => readTarget(file, root, { maxFileBytes: c.limits?.maxFileBytes ?? ABSOLUTE_PROMPT_FILE_BYTES }, Boolean(c.redact)))
  for (const file of selected.slice(maxFiles)) skipped.push(unreviewed(file, `snapshot exceeds ${maxFiles} file limit`))
  const maxBytes = Math.min(c.limits?.maxBytes ?? DEFAULT_TOTAL_BYTES, ABSOLUTE_TOTAL_BYTES); let total = 0
  for (const target of targets) {
    total += Buffer.byteLength(target.fullContent, 'utf8')
    if (total > maxBytes && target.reviewStatus !== 'UNREVIEWED') { target.fullContent = ''; target.reviewStatus = 'UNREVIEWED'; target.unreviewedReason = `snapshot exceeds ${maxBytes} byte limit` }
  }
  return [...skipped, ...targets]
}

function fromStdin(c: Extract<SourceConfig, { kind: 'stdin' }>): ReviewTarget[] {
  const file = c.filename ?? 'snippet.txt'; const content = c.redact ? redactSecrets(c.content) : c.content
  const size = Buffer.byteLength(content, 'utf8'); const limit = c.limits?.maxFileBytes ?? DEFAULT_PROMPT_FILE_BYTES
  return [size > limit ? unreviewed(file, `file exceeds ${limit} byte limit`) : { file, language: langOf(file), fullContent: content, isChanged: true }]
}

export async function loadTargets(source: SourceConfig): Promise<ReviewTarget[]> {
  switch (source.kind) {
    case 'git-diff': return fromGitDiff(source)
    case 'github-pr': return fromGithubPr(source)
    case 'paths': return fromPaths(source)
    case 'stdin': return fromStdin(source)
    case 'isolated-snapshot': return fromSnapshot(source)
  }
}

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

const authors = z.string().min(1).max(100)
const repository = z.string().regex(/^[^/\s]+\/[^#\s]+$/, 'must be owner/repository')
const relativePath = z.string().min(1).refine(
  (value) => !isAbsolute(value) && !value.split('/').includes('..') && !value.split('\\').includes('..'),
  'must be repository-relative and cannot contain ..',
)

export const ReviewConfigSchema = z.object({
  version: z.literal(1),
  target: z.object({
    provider: z.enum(['github', 'gitlab']).default('github'),
    repository,
    projectId: z.string().min(1).optional(),
    authors: z.array(authors).min(1).optional(),
    excludeAuthors: z.array(authors).optional(),
    baseBranch: z.string().min(1).default('main'),
  }).strict(),
  review: z.object({
    preset: z.string().min(1).optional(),
    lenses: z.object({
      correctness: z.boolean().optional(), security: z.boolean().optional(), performance: z.boolean().optional(),
      maintainability: z.boolean().optional(), design: z.boolean().optional(), tests: z.boolean().optional(), conventions: z.boolean().optional(),
    }).strict().optional(),
    provider: z.string().min(1).default('codex-cli'),
    model: z.string().min(1).optional(),
    mode: z.enum(['isolated', 'trusted-local']).default('isolated'),
    votes: z.number().int().min(1).max(25).default(3),
    minSeverity: z.enum(['blocker', 'high', 'med', 'nit']).default('nit'),
    minConfidence: z.number().min(0).max(1).optional(),
    maxFindingsPerFile: z.number().int().min(1).max(100).default(7),
    maxCalls: z.number().int().min(1).max(1000).default(1000),
    deadlineMs: z.number().int().min(1).max(30 * 60 * 1000).default(600_000),
    healthCheck: z.enum(['auto', 'off']).default('auto'),
    conventions: relativePath.optional(),
  }).strict(),
  memory: z.object({
    enabled: z.boolean().default(true),
    provider: z.enum(['self-hosted', 'agentskit']).default('self-hosted'),
    path: relativePath.default('.agentskit/review-memory'),
    retentionDays: z.number().int().min(1).max(3650).default(365),
    learnFromFeedback: z.boolean().default(true),
    autoPromoteRules: z.boolean().default(false),
  }).strict().default({}),
  feedback: z.object({
    enabled: z.boolean().default(true),
    learnFromAcceptedFindings: z.boolean().default(true),
    learnFromRejectedFindings: z.boolean().default(true),
    learnFromFixedFindings: z.boolean().default(true),
    requireApprovalForRules: z.boolean().default(true),
  }).strict().default({}),
  comments: z.object({
    renderer: z.enum(['github-inline', 'coderabbit-inspired', 'compact', 'detailed']).default('coderabbit-inspired'),
    language: z.string().min(2).max(20).default('en'),
    inline: z.boolean().default(true),
    summary: z.boolean().default(true),
    collapsibleDetails: z.boolean().default(true),
    includeReason: z.boolean().default(true),
    includeImpact: z.boolean().default(true),
    includeInstructions: z.boolean().default(true),
    includeEvidence: z.boolean().default(true),
  }).strict().default({}),
  batches: z.object({
    enabled: z.boolean().default(true),
    size: z.number().int().min(1).max(100).default(10),
    requireCompleteCoverage: z.boolean().default(true),
    failOnUnreviewableFiles: z.boolean().default(true),
  }).strict().default({}),
  merge: z.object({
    enabled: z.boolean().default(false),
    method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
    requireCleanReview: z.boolean().default(true),
    requireCurrentSha: z.boolean().default(true),
    requireSuccessfulChecks: z.boolean().default(true),
    requireNoChangesRequested: z.boolean().default(true),
    forbidAdmin: z.boolean().default(true),
    forbidForce: z.boolean().default(true),
  }).strict().default({}),
  execution: z.object({
    continueAfterPerPrFailure: z.boolean().default(true),
    maxConcurrentPullRequests: z.number().int().min(1).max(16).default(1),
    resumeIncompleteRuns: z.boolean().default(true),
    cleanupTemporaryArtifacts: z.boolean().default(true),
    statePath: relativePath.default('.agentskit/review-state'),
  }).strict().default({}),
  report: z.object({
    format: z.enum(['json', 'markdown', 'both']).default('json'),
    includeEveryDiscoveredPullRequest: z.boolean().default(true),
    failOnEmptyReport: z.boolean().default(true),
    redactSecrets: z.boolean().default(true),
  }).strict().default({}),
}).strict()

export type ReviewProjectConfig = z.infer<typeof ReviewConfigSchema>

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T
export type ConfigInput = DeepPartial<Omit<ReviewProjectConfig, 'version'>> & { version?: 1 }

export class PublicConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicConfigError'
  }
}

function parseConfig(value: unknown): ReviewProjectConfig {
  const result = ReviewConfigSchema.safeParse({ version: 1, ...(value as object) })
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ')
    throw new PublicConfigError(`invalid code-review config: ${details}`)
  }
  return result.data
}

export function defineConfig(value: ConfigInput): ReviewProjectConfig {
  return parseConfig(value)
}

export function validateConfig(value: unknown): ReviewProjectConfig {
  return parseConfig(value)
}

export function configFingerprint(config: ReviewProjectConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

export function generateConfigSchema(): Record<string, unknown> {
  return zodToJsonSchema(ReviewConfigSchema, { name: 'AgentsKitCodeReviewConfig' }) as Record<string, unknown>
}

export function toReviewConfig(config: ReviewProjectConfig): Record<string, unknown> {
  const required = new Set(['correctness', 'security', 'tests'])
  const lenses = Object.fromEntries(Object.entries({
    correctness: config.review.lenses?.correctness ?? true,
    security: config.review.lenses?.security ?? true,
    performance: config.review.lenses?.performance ?? true,
    maintainability: config.review.lenses?.maintainability ?? true,
    design: config.review.lenses?.design ?? true,
    tests: config.review.lenses?.tests ?? true,
    conventions: config.review.lenses?.conventions ?? true,
  }).map(([key, enabled]) => [key, { enabled, required: required.has(key) && enabled }]))
  return {
    configVersion: 1,
    lenses,
    provider: config.review.provider,
    model: config.review.model,
    trustMode: config.review.mode,
    healthCheck: config.review.healthCheck,
    votes: config.review.votes,
    thresholds: { minSeverity: config.review.minSeverity, minConfidence: config.review.minConfidence, maxPerFile: config.review.maxFindingsPerFile },
    budget: { maxCalls: config.review.maxCalls, deadlineMs: config.review.deadlineMs, concurrency: config.execution.maxConcurrentPullRequests },
    conventions: config.review.conventions,
  }
}

export const presets = {
  standard: (): ConfigInput => ({
    target: { provider: 'github', repository: 'owner/repository' },
    review: {},
  }),
  strict: (): ConfigInput => ({
    target: { provider: 'github', repository: 'owner/repository' },
    review: { votes: 3, minSeverity: 'nit', maxCalls: 1000 },
    merge: { enabled: true },
  }),
  fast: (): ConfigInput => ({
    target: { provider: 'github', repository: 'owner/repository' },
    review: { votes: 1, maxCalls: 250, deadlineMs: 120_000 },
    batches: { enabled: false },
  }),
} as const

async function importConfigModule(file: string): Promise<unknown> {
  try {
    const module = await import(pathToFileURL(file).href)
    return unwrapConfigModule(module)
  } catch (error) {
    throw new PublicConfigError(`unable to load ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function unwrapConfigModule(module: unknown): unknown {
  let exported: unknown = module && typeof module === 'object'
    ? ((module as { default?: unknown; config?: unknown }).default ?? (module as { config?: unknown }).config ?? module)
    : module
  for (let depth = 0; depth < 3 && exported && typeof exported === 'object'; depth += 1) {
    const candidate = exported as { default?: unknown; 'module.exports'?: unknown }
    const nested = candidate.default ?? candidate['module.exports']
    if (nested === undefined || nested === exported) break
    exported = nested
  }
  return exported
}

export async function loadProjectConfig(cwd: string, requested?: string): Promise<{ config: ReviewProjectConfig; path?: string }> {
  const candidates = requested
    ? [resolve(cwd, requested)]
    : ['code-review.config.mjs', 'code-review.config.js', 'code-review.config.ts', '.agentskit-review.json'].map((file) => join(cwd, file))
  const file = candidates.find((candidate) => existsSync(candidate))
  if (!file) throw new PublicConfigError(`no config found; create code-review.config.ts or pass --config <path>`)
  if (file.endsWith('.json')) {
    try { return { config: parseConfig(JSON.parse(readFileSync(file, 'utf8'))), path: file } }
    catch (error) { if (error instanceof PublicConfigError) throw error; throw new PublicConfigError(`unable to load ${file}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (file.endsWith('.ts')) {
    try {
      const { register } = await import('tsx/esm/api')
      const scope = register({ namespace: `agentskit-review-config-${Date.now()}` })
      try {
        return { config: parseConfig(unwrapConfigModule(await scope.import(pathToFileURL(file).href, import.meta.url))), path: file }
      } finally { await scope.unregister() }
    } catch (error) {
      if (error instanceof PublicConfigError) throw error
      throw new PublicConfigError(`unable to load ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { config: parseConfig(await importConfigModule(file)), path: file }
}

export function configSchemaFilePath(cwd: string): string {
  return join(dirname(resolve(cwd)), 'code-review.config.schema.json')
}

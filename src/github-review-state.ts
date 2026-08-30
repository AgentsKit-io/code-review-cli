import { createHash } from 'node:crypto'

const API = 'https://api.github.com'
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000
export const MAX_GITHUB_RESPONSE_BYTES = 25 * 1024 * 1024
const MARKER_PREFIX = '<!-- agentskit-code-review:v1'
const COMMENT_PAGE_SIZE = 100
const MAX_COMMENT_PAGES = 10

export class GithubResponseLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`GitHub response exceeded ${maxBytes} byte limit`)
    this.name = 'GithubResponseLimitError'
  }
}

export interface GithubReviewIdentity {
  owner: string
  repo: string
  number: number
  sha: string
  baseSha: string
  fork: boolean
}

export interface GithubReviewState extends GithubReviewIdentity {
  fingerprint: string
  marker: string
  alreadyReviewed: boolean
  scope: 'incremental' | 'full'
  baselineSha?: string
}

export function reviewFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function reviewMarker(sha: string, fingerprint: string): string {
  return `${MARKER_PREFIX} sha=${sha} fingerprint=${fingerprint} -->`
}

function retryableGithubGet(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /GitHub GET .* → (429|5\d\d)/.test(message)
    || /(?:aborted|timed out|fetch failed|network)/i.test(message)
}

export async function readGithubResponseText(response: Response, maxBytes = MAX_GITHUB_RESPONSE_BYTES): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new GithubResponseLimitError(maxBytes)
    return text
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new GithubResponseLimitError(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

async function responseDetail(response: Response): Promise<string> {
  try { return (await readGithubResponseText(response, 4096)).trim().slice(0, 300) }
  catch (error) { return error instanceof GithubResponseLimitError ? error.message : '' }
}

export async function githubFetch(token: string, url: string, accept = 'application/vnd.github+json'): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept, 'user-agent': 'agentskit-code-review' },
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        const detail = await responseDetail(response)
        throw new Error(`GitHub GET ${url} → ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      return response
    } catch (error) {
      lastError = error
      if (attempt === 1 || !retryableGithubGet(error)) throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('GitHub GET failed')
}

export async function githubGet<T>(token: string, path: string): Promise<T> {
  const response = await githubFetch(token, `${API}${path}`)
  return JSON.parse(await readGithubResponseText(response)) as T
}

export interface GithubIssueComment {
  id?: number
  body?: string
}

export async function githubIssueComments(token: string, owner: string, repo: string, number: number): Promise<{ comments: GithubIssueComment[]; truncated: boolean }> {
  const comments: GithubIssueComment[] = []
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const batch = await githubGet<GithubIssueComment[]>(token, `/repos/${owner}/${repo}/issues/${number}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}&sort=created&direction=desc`)
    comments.push(...batch)
    if (batch.length < COMMENT_PAGE_SIZE) return { comments, truncated: false }
  }
  return { comments, truncated: true }
}

export function markerIn(body: string | undefined, marker: string): boolean {
  return body?.includes(marker) ?? false
}

function previousMarker(body: string | undefined, fingerprint: string): string | undefined {
  const match = body?.match(new RegExp(`${MARKER_PREFIX} sha=([^ ]+) fingerprint=${fingerprint} -->`))
  return match?.[1]
}

export async function getGithubReviewState(input: {
  owner: string
  repo: string
  number: number
  token: string
  fingerprint: string
}): Promise<GithubReviewState> {
  const pr = await githubGet<{
    head: { sha: string; repo?: { full_name?: string } }
    base: { sha: string; repo?: { full_name?: string } }
  }>(input.token, `/repos/${input.owner}/${input.repo}/pulls/${input.number}`)
  const marker = reviewMarker(pr.head.sha, input.fingerprint)
  const history = await githubIssueComments(input.token, input.owner, input.repo, input.number)
  if (history.truncated) throw new Error(`GitHub review comment history exceeded ${MAX_COMMENT_PAGES * COMMENT_PAGE_SIZE} comments; refusing to post without idempotency proof`)
  const comments = history.comments
  const previousSha = comments.map((comment) => previousMarker(comment.body, input.fingerprint)).find(Boolean)
  let scope: GithubReviewState['scope'] = 'full'
  if (previousSha && previousSha !== pr.head.sha) {
    const comparison = await githubGet<{ status?: string }>(input.token, `/repos/${input.owner}/${input.repo}/compare/${previousSha}...${pr.head.sha}`)
    if (comparison.status === 'ahead') scope = 'incremental'
  }
  return {
    owner: input.owner,
    repo: input.repo,
    number: input.number,
    sha: pr.head.sha,
    baseSha: pr.base.sha,
    fork: pr.head.repo?.full_name !== undefined && pr.head.repo.full_name !== pr.base.repo?.full_name,
    fingerprint: input.fingerprint,
    marker,
    alreadyReviewed: comments.some((comment) => markerIn(comment.body, marker)),
    scope,
    ...(scope === 'incremental' && previousSha ? { baselineSha: previousSha } : {}),
  }
}

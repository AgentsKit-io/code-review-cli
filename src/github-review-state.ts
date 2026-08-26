import { createHash } from 'node:crypto'

const API = 'https://api.github.com'
const GET_TIMEOUT_MS = 5_000
const MARKER_PREFIX = '<!-- agentskit-code-review:v1'

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

export async function githubGet<T>(token: string, path: string): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${API}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'agentskit-code-review' },
        signal: AbortSignal.timeout(GET_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`GitHub GET ${path} → ${response.status}`)
      return await response.json() as T
    } catch (error) {
      lastError = error
      if (attempt === 1) throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('GitHub GET failed')
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
  const comments = await githubGet<Array<{ body?: string }>>(
    input.token,
    `/repos/${input.owner}/${input.repo}/issues/${input.number}/comments?per_page=100`,
  )
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

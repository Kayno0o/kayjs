import type { Duration } from 'kay'
import type { Commit, FileChange, FileMove, FileSaver, Identity } from './files'
import { optionMs } from 'kay/library'
import { checkBase, errorMessage, ForgeError, networkReason, requireSecure, SaveConflictError, TRAILING_SLASHES } from './files'

export interface GithubOptions {
  // `owner/name`.
  repo: string
  // The repository's default branch when left out.
  branch?: string | undefined
  // A token allowed to write the repository's contents.
  token: string
  // The REST API's address: `https://api.github.com` by default, `https://github.example.com/api/v3` for a GitHub Enterprise Server.
  baseUrl?: string | undefined
  // How long a save may take, its requests to GitHub together, before it fails: `'15s'` by default.
  timeout?: Duration | undefined
  fetch?: typeof fetch | undefined
}

interface Ref {
  object: { sha: string }
}

interface TreeEntry {
  path: string
  mode: '100644'
  type: 'blob'
  // Rewriting a file resets its mode, which content files never need changed.
  // null deletes the path; a path with `content` is written.
  sha?: null
  content?: string
}

// A branch moving between reading its head and updating it is retried from the read, as the other save may have touched other files.
const ATTEMPTS = 3
const NOT_FAST_FORWARD = /fast.?forward/i

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function written(path: string, content: string): TreeEntry {
  return { path, mode: '100644', type: 'blob', content }
}

function removed(path: string): TreeEntry {
  return { path, mode: '100644', type: 'blob', sha: null }
}

// Commits each change through GitHub's Git Data API (tree, commit, then the branch's ref moved to it), so a save of several files is one commit or none and the site rebuilds from git.
export function github({ repo, branch, token, baseUrl = 'https://api.github.com', timeout: wait = '15s', fetch: request = fetch }: GithubOptions): FileSaver {
  const timeout = optionMs(wait, 'github timeout')

  requireSecure(baseUrl, 'github')

  const api = `${baseUrl.replace(TRAILING_SLASHES, '')}/repos/${repo}`
  const headers = { 'authorization': `Bearer ${token}`, 'content-type': 'application/json', 'accept': 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }

  async function answer<T>(response: Response): Promise<T> {
    if (response.ok)
      return await response.json() as T

    throw new ForgeError(response.status, `GitHub answered ${response.status}: ${await errorMessage(response, 'GitHub')}`)
  }

  async function send<T>(path: string, signal: AbortSignal, method = 'GET', body?: object): Promise<T> {
    return answer<T>(await request(`${api}${path}`, { method, headers, signal, body: body === undefined ? null : JSON.stringify(body) }))
  }

  async function branchName(signal: AbortSignal): Promise<string> {
    return branch ?? (await send<{ default_branch: string }>('', signal)).default_branch
  }

  // The blob sha of the file at a commit, which is the version an editor opened; undefined when it does not exist.
  async function versionAt(commit: string, repoPath: string, signal: AbortSignal): Promise<string | undefined> {
    const response = await request(`${api}/contents/${encodePath(repoPath)}?ref=${commit}`, { headers, signal })

    if (response.status === 404)
      return undefined

    const found = await answer<{ sha: string } | unknown[]>(response)

    if (Array.isArray(found))
      throw new ForgeError(422, `GitHub: '${repoPath}' is a folder, not a file`)

    return found.sha
  }

  // Commits what `plan` reads at the branch's head and judges, undefined when it plans nothing; a head that moved meanwhile makes the whole read happen again, so a conflict is only ever reported for a file that changed.
  async function commit(message: string, author: Identity | undefined, signal: AbortSignal, posting: (made: boolean) => void, plan: (head: string, signal: AbortSignal) => Promise<TreeEntry[] | undefined>): Promise<Commit | undefined> {
    const name = await branchName(signal)

    for (let attempt = 1; ; attempt++) {
      posting(false)
      const head = (await send<Ref>(`/git/ref/heads/${encodePath(name)}`, signal)).object.sha
      const planned = await plan(head, signal)

      if (planned === undefined)
        return undefined

      const { tree } = await send<{ tree: { sha: string } }>(`/git/commits/${head}`, signal)
      const made = await send<{ sha: string }>('/git/trees', signal, 'POST', { base_tree: tree.sha, tree: planned })
      const created = await send<{ sha: string, html_url?: string }>('/git/commits', signal, 'POST', { message, tree: made.sha, parents: [head], author })

      // Nothing is visible before the ref moves, so a failure until here leaves the repository as it was.
      posting(true)

      const moved = await request(`${api}/git/refs/heads/${encodePath(name)}`, { method: 'PATCH', headers, signal, body: JSON.stringify({ sha: created.sha, force: false }) })

      if (moved.ok)
        return { sha: created.sha, url: created.html_url }

      // Not a fast forward: another save moved the branch, so the versions are read again from its new head.
      if ((moved.status === 422 || moved.status === 409) && NOT_FAST_FORWARD.test(await moved.clone().text())) {
        if (attempt < ATTEMPTS)
          continue

        throw new SaveConflictError()
      }

      await answer(moved)
    }
  }

  async function save({ repoPath, text, message, author, base }: FileChange, signal: AbortSignal, posting: (made: boolean) => void): Promise<Commit | undefined> {
    return commit(message, author, signal, posting, async (head, planSignal) => {
      const version = await versionAt(head, repoPath, planSignal)

      checkBase(base, version)

      if (text === undefined && version === undefined)
        return undefined

      return [text === undefined ? removed(repoPath) : written(repoPath, text)]
    })
  }

  async function move({ from, to, text, message, author, base, also = [] }: FileMove, signal: AbortSignal, posting: (made: boolean) => void): Promise<Commit> {
    const saved = await commit(message, author, signal, posting, async (head, planSignal) => {
      const [sha, taken, ...held] = await Promise.all([from.repoPath, to.repoPath, ...also.map(change => change.repoPath)].map(async path => versionAt(head, path, planSignal)))

      checkBase(base, sha)

      if (sha === undefined)
        throw new SaveConflictError(null)

      if (taken !== undefined)
        throw new SaveConflictError(undefined, true)

      const entries = [removed(from.repoPath), written(to.repoPath, text)]

      for (const [i, change] of also.entries()) {
        checkBase(change.base, held[i], change.repoPath)

        if (held[i] === undefined)
          throw new SaveConflictError(null, false, change.repoPath)

        entries.push(written(change.repoPath, change.text))
      }

      return entries
    })

    // A move always plans entries, so a commit exists.
    return saved!
  }

  // Turns what a request threw into the error a save reports; once the ref was being moved, GitHub may have moved it without its answer arriving.
  async function guarded<T>(run: (signal: AbortSignal, posting: (made: boolean) => void) => Promise<T>): Promise<T> {
    let posted = false

    try {
      return await run(AbortSignal.timeout(timeout), made => posted = made)
    }
    catch (error) {
      if (error instanceof SaveConflictError || error instanceof ForgeError)
        throw error

      const unsure = posted ? ': the save may still have gone through, so check the repository before saving again' : ''

      if (error instanceof Error && error.name === 'TimeoutError')
        throw new ForgeError(504, `GitHub did not answer within ${timeout / 1000} s${unsure}`, { cause: error })

      throw new ForgeError(502, `Could not reach GitHub (${networkReason(error)})${unsure}`, { cause: error })
    }
  }

  return {
    async save(change) {
      return guarded(async (signal, posting) => save(change, signal, posting))
    },
    async move(change) {
      return guarded(async (signal, posting) => move(change, signal, posting))
    },
    together: true,
  }
}

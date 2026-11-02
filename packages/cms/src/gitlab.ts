import type { Duration } from 'kay'
import type { Commit, FileChange, FileMove, FileSaver, Identity } from './files'
import { optionMs } from 'kay/library'
import { checkBase, errorMessage, ForgeError, networkReason, requireSecure, SaveConflictError, TRAILING_SLASHES } from './files'

export interface GitlabOptions {
  // `group/name`, or `group/subgroup/name`.
  repo: string
  // The repository's default branch when left out.
  branch?: string | undefined
  // A personal, project or group access token allowed to write the repository (scope `api`).
  token: string
  // The GitLab's address: `https://gitlab.com` by default, `https://gitlab.example.com` for a self-managed one.
  baseUrl?: string | undefined
  // How long a save may take, its requests to GitLab together, before it fails: `'15s'` by default.
  timeout?: Duration | undefined
  fetch?: typeof fetch | undefined
}

interface FileAction {
  action: 'create' | 'update' | 'delete' | 'move'
  file_path: string
  previous_path?: string
  content?: string
  // The last commit that touched the file, which GitLab refuses the action when it is no longer.
  last_commit_id?: string
}

interface Found {
  // The git blob sha, which is `fileVersion` of the content.
  version: string
  last: string
}

// A file changed, appeared or vanished between reading it and committing is retried from the read, as the other save may have touched other files.
const ATTEMPTS = 3
const CHANGED = /changed since|already exists|doesn.t exist|does not exist/i

// Commits each change through GitLab's Commits API, which takes every action of a save in one commit, so a save of several files is one commit or none and the site rebuilds from git.
export function gitlab({ repo, branch, token, baseUrl = 'https://gitlab.com', timeout: wait = '15s', fetch: request = fetch }: GitlabOptions): FileSaver {
  const timeout = optionMs(wait, 'gitlab timeout')

  requireSecure(baseUrl, 'gitlab')

  const api = `${baseUrl.replace(TRAILING_SLASHES, '')}/api/v4/projects/${encodeURIComponent(repo)}`
  const headers = { 'private-token': token, 'content-type': 'application/json' }

  async function answer<T>(response: Response): Promise<T> {
    if (response.ok)
      return await response.json() as T

    throw new ForgeError(response.status, `GitLab answered ${response.status}: ${await errorMessage(response, 'GitLab')}`)
  }

  async function branchName(signal: AbortSignal): Promise<string> {
    if (branch !== undefined)
      return branch

    const project = await answer<{ default_branch?: string | null }>(await request(api, { headers, signal }))

    if (project.default_branch === undefined || project.default_branch === null || project.default_branch === '')
      throw new ForgeError(422, 'GitLab: the repository has no default branch, so name one with `branch`')

    return project.default_branch
  }

  // The file at a commit: its blob sha, which is the version an editor opened, and the commit that last touched it; undefined when it does not exist.
  async function find(commit: string, repoPath: string, signal: AbortSignal): Promise<Found | undefined> {
    const response = await request(`${api}/repository/files/${encodeURIComponent(repoPath)}?ref=${commit}`, { headers, signal })

    if (response.status === 404)
      return undefined

    const found = await answer<{ blob_id: string, last_commit_id: string }>(response)

    return { version: found.blob_id, last: found.last_commit_id }
  }

  // Commits what `plan` reads at the branch's head and judges, undefined when it plans nothing; a file that changed under the commit makes the whole read happen again, so a conflict is only ever reported for a file that changed.
  async function commit(message: string, author: Identity | undefined, signal: AbortSignal, posting: (made: boolean) => void, plan: (head: string, signal: AbortSignal) => Promise<FileAction[] | undefined>): Promise<Commit | undefined> {
    const name = await branchName(signal)

    for (let attempt = 1; ; attempt++) {
      posting(false)
      const head = (await answer<{ commit: { id: string } }>(await request(`${api}/repository/branches/${encodeURIComponent(name)}`, { headers, signal }))).commit.id
      const actions = await plan(head, signal)

      if (actions === undefined)
        return undefined

      posting(true)

      const body = { branch: name, commit_message: message, actions, author_name: author?.name, author_email: author?.email }
      const response = await request(`${api}/repository/commits`, { method: 'POST', headers, signal, body: JSON.stringify(body) })

      if (response.ok) {
        const created = await response.json() as { id: string, web_url?: string }

        return { sha: created.id, url: created.web_url }
      }

      // A file the plan read has changed since, so the versions are read again from the branch.
      if ((response.status === 400 || response.status === 409) && CHANGED.test(await response.clone().text())) {
        if (attempt < ATTEMPTS)
          continue

        throw new SaveConflictError()
      }

      await answer(response)
    }
  }

  async function save({ repoPath, text, message, author, base }: FileChange, signal: AbortSignal, posting: (made: boolean) => void): Promise<Commit | undefined> {
    return commit(message, author, signal, posting, async (head, planSignal) => {
      const found = await find(head, repoPath, planSignal)

      checkBase(base, found?.version)

      if (found === undefined)
        return text === undefined ? undefined : [{ action: 'create', file_path: repoPath, content: text }]

      return [text === undefined ? { action: 'delete', file_path: repoPath, last_commit_id: found.last } : { action: 'update', file_path: repoPath, content: text, last_commit_id: found.last }]
    })
  }

  async function move({ from, to, text, message, author, base, also = [] }: FileMove, signal: AbortSignal, posting: (made: boolean) => void): Promise<Commit> {
    const saved = await commit(message, author, signal, posting, async (head, planSignal) => {
      const [source, taken, ...held] = await Promise.all([from.repoPath, to.repoPath, ...also.map(change => change.repoPath)].map(async path => find(head, path, planSignal)))

      checkBase(base, source?.version)

      if (source === undefined)
        throw new SaveConflictError(null)

      if (taken !== undefined)
        throw new SaveConflictError(undefined, true)

      const actions: FileAction[] = [{ action: 'move', previous_path: from.repoPath, file_path: to.repoPath, content: text, last_commit_id: source.last }]

      for (const [i, change] of also.entries()) {
        const found = held[i]

        checkBase(change.base, found?.version, change.repoPath)

        if (found === undefined)
          throw new SaveConflictError(null, false, change.repoPath)

        actions.push({ action: 'update', file_path: change.repoPath, content: change.text, last_commit_id: found.last })
      }

      return actions
    })

    // A move always plans actions, so a commit exists.
    return saved!
  }

  // Turns what a request threw into the error a save reports; once the commit was being posted, GitLab may have made it without its answer arriving.
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
        throw new ForgeError(504, `GitLab did not answer within ${timeout / 1000} s${unsure}`, { cause: error })

      throw new ForgeError(502, `Could not reach GitLab (${networkReason(error)})${unsure}`, { cause: error })
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

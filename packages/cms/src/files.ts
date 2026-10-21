import type { Duration } from 'kay'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { configError, optionMs } from 'kay/library'
import { wording } from 'kay/words'
import { log } from './log'

export interface Identity {
  name: string
  email: string
}

export interface FileChange {
  // Relative to the git root.
  repoPath: string
  absolute: string
  // The file's new text, or undefined to delete it.
  text: string | undefined
  message: string
  author?: Identity | undefined
  // The version of the file the change was made from, as `fileVersion` gives it: null when it must not exist yet, undefined to write whatever is there.
  base?: string | null | undefined
}

// A file moved to another path with new text, in one commit: the path of an entry whose slug changed.
export interface FileMove {
  from: { repoPath: string, absolute: string }
  to: { repoPath: string, absolute: string }
  // The text the file has at `to`.
  text: string
  message: string
  author?: Identity | undefined
  // The version of the file at `from` the move is made from, as `fileVersion` gives it; undefined to move whatever is there. `to` must not exist yet.
  base?: string | undefined
  // Other files rewritten in the same commit, the entries that named the renamed one. Each has a `base`, and one at another version refuses the whole move with a `SaveConflictError` naming its path in `at`.
  also?: (FileChange & { text: string })[] | undefined
}

export interface Commit {
  sha: string
  url?: string | undefined
}

// Where a folder entry's file goes once saved: a commit, or the working tree.
// A saver given a `base` throws a `SaveConflictError` when the file is no longer at that version.
// `move` renames an entry's file; a saver without it refuses to rename entries. A move throws a `SaveConflictError` when `from` is not at its `base`, is gone, or `to` exists.
// `together` says `move` writes the move's `also` files with it; without it the entries that named the renamed one are saved one by one after the move.
export interface FileSaver {
  save: (change: FileChange) => Promise<Commit | undefined>
  move?: ((move: FileMove) => Promise<Commit | undefined>) | undefined
  together?: boolean | undefined
}

// A save made from a version of the file another save has replaced since, or a new file where one already is.
// `current` is the version the file is at, null once deleted, undefined when the saver could not tell.
// `at` is the repository path of the file refused, when a move refuses one that is not the one moved.
export class SaveConflictError extends Error {
  override readonly name = 'SaveConflictError'
  readonly code = 'save-conflict'

  constructor(readonly current?: string | null, readonly creating = false, readonly at?: string) {
    super(creating ? wording('cms.store.exists', 'An entry with this slug already exists: pick another slug') : wording('cms.store.conflict', 'This entry was saved since you opened it, by another save or by yours before the site rebuilt from it'))
  }
}

/** @deprecated Renamed `SaveConflictError` in 1.70; the old name goes in 1.73. */
export const SaveConflict = SaveConflictError
/** @deprecated Renamed `SaveConflictError` in 1.70; the old name goes in 1.73. */
export type SaveConflict = SaveConflictError

// The git blob sha of a file's bytes, which Forgejo names a file's version by.
export function fileVersion(bytes: Uint8Array | string): string {
  const content = typeof bytes === 'string' ? Buffer.from(bytes) : bytes

  return new Bun.CryptoHasher('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex')
}

function checkBase(base: string | null | undefined, current: string | undefined, at?: string): void {
  if (base !== undefined && base !== (current ?? null))
    throw new SaveConflictError(current ?? null, base === null, at)
}

// The last write of each file in the working tree, which the next one waits for, so two saves never both pass the version check.
const writes = new Map<string, Promise<unknown>>()

// Runs `write` after the writes ahead of it on any of the files, and makes it the last of each.
async function afterWrites<T>(files: string[], write: () => Promise<T>): Promise<T> {
  const previous = files.map(async file => writes.get(file))
  const running = (async () => {
    for (const earlier of previous) {
      try {
        await earlier
      }
      catch {}
    }

    return write()
  })()

  for (const file of files)
    writes.set(file, running)

  try {
    return await running
  }
  finally {
    for (const file of files) {
      if (writes.get(file) === running)
        writes.delete(file)
    }
  }
}

// Writes the file in place, for `kay dev`: on a deployed site the next deploy would drop it.
export function workingTree(): FileSaver {
  return {
    async save(change) {
      return afterWrites([change.absolute], async () => writeFile(change))
    },
    async move(move) {
      return afterWrites([move.from.absolute, move.to.absolute, ...move.also?.map(change => change.absolute) ?? []], async () => moveFile(move))
    },
    together: true,
  }
}

async function moveFile({ from, to, text, base, also = [] }: FileMove): Promise<undefined> {
  const source = Bun.file(from.absolute)

  if (!await source.exists())
    throw new SaveConflictError(null)

  checkBase(base, fileVersion(await source.bytes()))

  if (await Bun.file(to.absolute).exists())
    throw new SaveConflictError(undefined, true)

  // Every version is checked before the first write, so a refused referrer leaves the tree as it was.
  for (const change of also) {
    const file = Bun.file(change.absolute)

    checkBase(change.base, await file.exists() ? fileVersion(await file.bytes()) : undefined, change.repoPath)
  }

  for (const change of also)
    await Bun.write(change.absolute, change.text)

  await mkdir(dirname(to.absolute), { recursive: true })
  await Bun.write(to.absolute, text)
  await rm(from.absolute, { force: true })

  return undefined
}

async function writeFile({ absolute, text, base }: FileChange): Promise<undefined> {
  if (base !== undefined) {
    const file = Bun.file(absolute)

    checkBase(base, await file.exists() ? fileVersion(await file.bytes()) : undefined)
  }

  if (text === undefined) {
    await rm(absolute, { force: true })

    return undefined
  }

  await mkdir(dirname(absolute), { recursive: true })
  await Bun.write(absolute, text)

  return undefined
}

interface ForgejoSettings {
  // `owner/name`.
  repo: string
  // The repository's default branch when left out.
  branch?: string | undefined
  // A token allowed to write the repository's contents.
  token: string
  // How long a save may take, its requests to the forge together, before it fails: `'15s'` by default. The extra read naming the file's version after a conflict has its own.
  timeout?: Duration | undefined
  fetch?: typeof fetch | undefined
}

// The forge's address is `baseUrl`, `https://git.example.com`, as a service API is named across kay's libraries; `url` still works until 1.73 (the `deprecated-option-name` lint).
export type ForgejoOptions = ForgejoSettings & (
  | { baseUrl: string, url?: string | undefined }
  | {
    /** @deprecated Since 1.70, dropped in 1.73: this is `baseUrl`. */
    url: string
    baseUrl?: string | undefined
  }
)

export class ForgeError extends Error {
  override readonly name = 'ForgeError'
  readonly code = 'forge-refused'

  constructor(readonly status: number, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

// Forgejo's refusal of an update naming a sha the branch no longer holds.
const SHA_MISMATCH = /sha/i
// How much of a refusal the editor is shown; the log gets it whole.
const SHOWN_REFUSAL = 200
const TRAILING_SLASHES = /\/+$/

function commitOperation(text: string | undefined, sha: string | undefined): 'delete' | 'create' | 'update' {
  if (text === undefined)
    return 'delete'

  return sha === undefined ? 'create' : 'update'
}

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/

// The token travels in every request, so a plain http: address is refused unless it is this machine's.
function requireSecure(url: string): void {
  const parsed = URL.parse(url)

  if (parsed === null || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK.test(parsed.hostname))))
    throw configError(`forgejo baseUrl is '${url}', which must be https:, or http: on localhost`)
}

// Commits each change through Forgejo's contents API, so the site rebuilds from git and every edit has history.
export function forgejo({ baseUrl, url: legacyUrl, repo, branch, token, timeout: wait = '15s', fetch: request = fetch }: ForgejoOptions): FileSaver {
  const timeout = optionMs(wait, 'forgejo timeout')
  const url = baseUrl ?? legacyUrl ?? ''

  requireSecure(url)
  const api = `${url.replace(TRAILING_SLASHES, '')}/api/v1/repos/${repo}`
  const headers = { 'authorization': `token ${token}`, 'content-type': 'application/json', 'accept': 'application/json' }

  async function answer<T>(response: Response): Promise<T> {
    if (response.ok)
      return await response.json() as T

    throw new ForgeError(response.status, `Forgejo answered ${response.status}: ${await errorMessage(response)}`)
  }

  // The blob sha of the file on the branch, which an update or a delete must name; undefined when it does not exist.
  async function currentSha(repoPath: string, signal: AbortSignal): Promise<string | undefined> {
    const query = branch === undefined ? '' : `?ref=${encodeURIComponent(branch)}`
    const response = await request(`${api}/contents/${repoPath.split('/').map(encodeURIComponent).join('/')}${query}`, { headers, signal })

    return response.status === 404 ? undefined : (await answer<{ sha: string }>(response)).sha
  }

  // Posts the files as one commit; a refused one reports the version of `conflictAt`, and `creating` says it was a new file that was refused.
  async function post(files: object[], { message, author }: { message: string, author?: Identity | undefined }, conflictAt: string, creating: boolean, signal: AbortSignal, posting: () => void): Promise<Commit> {
    posting()

    const response = await request(`${api}/contents`, { method: 'POST', headers, signal, body: JSON.stringify({ branch, message, author, files }) })

    // Another save landed between the read and the commit.
    if (response.status === 409 || (response.status === 422 && SHA_MISMATCH.test(await response.clone().text())))
      // The read of the version the conflict reports has its own time, as the save's may be all but spent on the commit that was refused.
      throw new SaveConflictError(await conflictVersion(async () => currentSha(conflictAt, AbortSignal.timeout(timeout))), creating)

    const { commit } = await answer<{ commit: { sha: string, html_url?: string } }>(response)

    return { sha: commit.sha, url: commit.html_url }
  }

  async function commit({ repoPath, text, message, author, base }: FileChange, signal: AbortSignal, posting: () => void): Promise<Commit | undefined> {
    const sha = await currentSha(repoPath, signal)

    checkBase(base, sha)

    if (text === undefined && sha === undefined)
      return undefined

    const operation = commitOperation(text, sha)
    const file = { operation, path: repoPath, sha, content: text === undefined ? undefined : Buffer.from(text).toString('base64') }

    return post([file], { message, author }, repoPath, operation === 'create', signal, posting)
  }

  // The file deleted at `from` and created at `to` in one commit, which git reads as a rename. The versions of the files are read together, so the many referrers of a rename stay under the one timeout.
  async function commitMove({ from, to, text, message, author, base, also = [] }: FileMove, signal: AbortSignal, posting: () => void): Promise<Commit> {
    const [sha, taken, ...held] = await Promise.all([from.repoPath, to.repoPath, ...also.map(change => change.repoPath)].map(async path => currentSha(path, signal)))

    checkBase(base, sha)

    if (sha === undefined)
      throw new SaveConflictError(null)

    if (taken !== undefined)
      throw new SaveConflictError(undefined, true)

    const files: object[] = [{ operation: 'delete', path: from.repoPath, sha }, { operation: 'create', path: to.repoPath, content: Buffer.from(text).toString('base64') }]

    for (const [i, change] of also.entries()) {
      checkBase(change.base, held[i], change.repoPath)

      if (held[i] === undefined)
        throw new SaveConflictError(null, false, change.repoPath)

      files.push({ operation: 'update', path: change.repoPath, sha: held[i], content: Buffer.from(change.text).toString('base64') })
    }

    try {
      return await post(files, { message, author }, from.repoPath, false, signal, posting)
    }
    catch (error) {
      // The forge refuses the commit without saying which file it found changed: when it is not the moved one, a referrer saved since is named.
      if (!(error instanceof SaveConflictError) || error.at !== undefined || (error.current !== undefined && error.current !== sha))
        throw error

      const now = await Promise.all(also.map(async change => conflictVersion(async () => currentSha(change.repoPath, AbortSignal.timeout(timeout)))))
      const changed = also.findIndex((_, i) => now[i] !== undefined && now[i] !== held[i])

      throw changed < 0 ? error : new SaveConflictError(now[changed], false, also[changed]!.repoPath)
    }
  }

  // Turns what a request threw into the error a save reports; once the commit was sent, the forge may have made it without its answer arriving.
  async function guarded<T>(run: (signal: AbortSignal, posting: () => void) => Promise<T>): Promise<T> {
    let posted = false

    try {
      return await run(AbortSignal.timeout(timeout), () => posted = true)
    }
    catch (error) {
      if (error instanceof SaveConflictError || error instanceof ForgeError)
        throw error

      const unsure = posted ? ': the save may still have gone through, so check the repository before saving again' : ''

      if (error instanceof Error && error.name === 'TimeoutError')
        throw new ForgeError(504, `Forgejo did not answer within ${timeout / 1000} s${unsure}`, { cause: error })

      throw new ForgeError(502, `Could not reach Forgejo (${networkReason(error)})${unsure}`, { cause: error })
    }
  }

  return {
    async save(change) {
      return guarded(async (signal, posting) => commit(change, signal, posting))
    },
    async move(change) {
      return guarded(async (signal, posting) => commitMove(change, signal, posting))
    },
    together: true,
  }
}

// The file's version once a commit was refused for naming another, or undefined when the forge cannot say.
async function conflictVersion(currentSha: () => Promise<string | undefined>): Promise<string | null | undefined> {
  try {
    return await currentSha() ?? null
  }
  catch {
    return undefined
  }
}

function networkReason(error: unknown): string {
  if (!(error instanceof Error))
    return String(error)

  const { code } = error as { code?: unknown }

  return typeof code === 'string' ? code : error.message
}

// Forgejo explains a refusal in a JSON `message`; a proxy in front of it may answer anything, an HTML page say, which is cut short and logged whole.
async function errorMessage(response: Response): Promise<string> {
  const text = await response.text()
  let message: string

  try {
    message = (JSON.parse(text) as { message?: string }).message ?? response.statusText
  }
  catch {
    message = text || response.statusText
  }

  if (message.length <= SHOWN_REFUSAL)
    return message

  log.warn(`Forgejo answered ${response.status}: ${message}`)

  return `${message.slice(0, SHOWN_REFUSAL)}…`
}

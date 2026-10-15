import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
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

export interface Commit {
  sha: string
  url?: string | undefined
}

// Where a folder entry's file goes once saved: a commit, or the working tree.
// A saver given a `base` throws a `SaveConflict` when the file is no longer at that version.
export interface FileSaver {
  save: (change: FileChange) => Promise<Commit | undefined>
}

// A save made from a version of the file another save has replaced since, or a new file where one already is.
// `current` is the version the file is at, null once deleted, undefined when the saver could not tell.
export class SaveConflict extends Error {
  constructor(readonly current?: string | null, readonly creating = false) {
    super(creating ? 'An entry with this slug already exists: pick another slug' : 'This entry was saved since you opened it, by another save or by yours before the site rebuilt from it')
  }
}

// The git blob sha of a file's bytes, which Forgejo names a file's version by.
export function fileVersion(bytes: Uint8Array | string): string {
  const content = typeof bytes === 'string' ? Buffer.from(bytes) : bytes

  return new Bun.CryptoHasher('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex')
}

function checkBase(base: string | null | undefined, current: string | undefined): void {
  if (base !== undefined && base !== (current ?? null))
    throw new SaveConflict(current ?? null, base === null)
}

// The last write of each file in the working tree, which the next one waits for, so two saves never both pass the version check.
const writes = new Map<string, Promise<unknown>>()

// Writes the file in place, for `kay dev`: on a deployed site the next deploy would drop it.
export function workingTree(): FileSaver {
  return {
    async save(change) {
      const previous = writes.get(change.absolute)
      const write = (async () => {
        try {
          await previous
        }
        catch {}

        return writeFile(change)
      })()

      writes.set(change.absolute, write)

      try {
        return await write
      }
      finally {
        if (writes.get(change.absolute) === write)
          writes.delete(change.absolute)
      }
    },
  }
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

export interface ForgejoOptions {
  // The forge's address, `https://git.example.com`.
  url: string
  // `owner/name`.
  repo: string
  // The repository's default branch when left out.
  branch?: string | undefined
  // A token allowed to write the repository's contents.
  token: string
  // How long a save may take, its requests to the forge together, before it fails, in milliseconds: 15 seconds by default. The extra read naming the file's version after a conflict has its own.
  timeout?: number | undefined
  fetch?: typeof fetch | undefined
}

export class ForgeError extends Error {
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

// Commits each change through Forgejo's contents API, so the site rebuilds from git and every edit has history.
export function forgejo({ url, repo, branch, token, timeout = 15_000, fetch: request = fetch }: ForgejoOptions): FileSaver {
  const api = `${url.replace(TRAILING_SLASHES, '')}/api/v1/repos/${repo}`
  const headers = { 'authorization': `token ${token}`, 'content-type': 'application/json', 'accept': 'application/json' }

  async function answer<T>(response: Response): Promise<T> {
    if (response.ok)
      return await response.json() as T

    throw new ForgeError(response.status, `Forgejo answered ${response.status}: ${await errorMessage(response)}`)
  }

  async function commit({ repoPath, text, message, author, base }: FileChange, signal: AbortSignal, posting: () => void): Promise<Commit | undefined> {
    const send = async (address: string, init: RequestInit = {}, within = signal) => request(address, { ...init, headers, signal: within })

    // The blob sha of the file on the branch, which an update or a delete must name; undefined when it does not exist.
    const currentSha = async (within = signal) => {
      const query = branch === undefined ? '' : `?ref=${encodeURIComponent(branch)}`
      const response = await send(`${api}/contents/${repoPath.split('/').map(encodeURIComponent).join('/')}${query}`, {}, within)

      return response.status === 404 ? undefined : (await answer<{ sha: string }>(response)).sha
    }

    const sha = await currentSha()

    checkBase(base, sha)

    if (text === undefined && sha === undefined)
      return undefined

    const operation = commitOperation(text, sha)
    const file = { operation, path: repoPath, sha, content: text === undefined ? undefined : Buffer.from(text).toString('base64') }

    posting()

    const response = await send(`${api}/contents`, {
      method: 'POST',
      body: JSON.stringify({ branch, message, author, files: [file] }),
    })

    // Another save landed between the read and the commit.
    if (response.status === 409 || (response.status === 422 && SHA_MISMATCH.test(await response.clone().text())))
      // The read of the version the conflict reports has its own time, as the save's may be all but spent on the commit that was refused.
      throw new SaveConflict(await conflictVersion(async () => currentSha(AbortSignal.timeout(timeout))), operation === 'create')

    const { commit } = await answer<{ commit: { sha: string, html_url?: string } }>(response)

    return { sha: commit.sha, url: commit.html_url }
  }

  return {
    async save(change) {
      let posted = false

      try {
        return await commit(change, AbortSignal.timeout(timeout), () => posted = true)
      }
      catch (error) {
        if (error instanceof SaveConflict || error instanceof ForgeError)
          throw error

        // Once the commit was sent, the forge may have made it without its answer arriving.
        const unsure = posted ? ': the save may still have gone through, so check the repository before saving again' : ''

        if (error instanceof Error && error.name === 'TimeoutError')
          throw new ForgeError(504, `Forgejo did not answer within ${timeout / 1000} s${unsure}`, { cause: error })

        throw new ForgeError(502, `Could not reach Forgejo (${networkReason(error)})${unsure}`, { cause: error })
      }
    },
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

import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

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

// A save made from a version of the file someone else has replaced since.
export class SaveConflict extends Error {
  constructor() {
    super('Someone saved this entry since you opened it: reload it once the site shows that save, then make your change again')
  }
}

// The git blob sha of a file's bytes, which Forgejo names a file's version by.
export function fileVersion(bytes: Uint8Array | string): string {
  const content = typeof bytes === 'string' ? Buffer.from(bytes) : bytes

  return new Bun.CryptoHasher('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex')
}

function checkBase(base: string | null | undefined, current: string | undefined): void {
  if (base !== undefined && base !== (current ?? null))
    throw new SaveConflict()
}

// Writes the file in place, for `kay dev`: on a deployed site the next deploy would drop it.
export function workingTree(): FileSaver {
  return {
    async save({ absolute, text, base }) {
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
    },
  }
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
  // How long each request to the forge may take before the save fails, in milliseconds: 15 seconds by default.
  timeout?: number | undefined
  fetch?: typeof fetch | undefined
}

export class ForgeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

// Commits each change through Forgejo's contents API, so the site rebuilds from git and every edit has history.
export function forgejo({ url, repo, branch, token, timeout = 15_000, fetch: request = fetch }: ForgejoOptions): FileSaver {
  const api = `${url.replace(/\/+$/, '')}/api/v1/repos/${repo}`
  const headers = { 'authorization': `token ${token}`, 'content-type': 'application/json', 'accept': 'application/json' }

  async function send(address: string, init: RequestInit = {}): Promise<Response> {
    return request(address, { ...init, headers, signal: AbortSignal.timeout(timeout) })
  }

  async function answer<T>(response: Response): Promise<T> {
    if (response.ok)
      return await response.json() as T

    throw new ForgeError(response.status, `Forgejo answered ${response.status}: ${await errorMessage(response)}`)
  }

  // The blob sha of the file on the branch, which an update or a delete must name; undefined when it does not exist.
  async function currentSha(path: string): Promise<string | undefined> {
    const query = branch === undefined ? '' : `?ref=${encodeURIComponent(branch)}`
    const response = await send(`${api}/contents/${path.split('/').map(encodeURIComponent).join('/')}${query}`)

    if (response.status === 404)
      return undefined

    return (await answer<{ sha: string }>(response)).sha
  }

  async function commit({ repoPath, text, message, author, base }: FileChange): Promise<Commit | undefined> {
    const sha = await currentSha(repoPath)

    checkBase(base, sha)

    if (text === undefined && sha === undefined)
      return undefined

    const operation = text === undefined ? 'delete' : sha === undefined ? 'create' : 'update'
    const file = { operation, path: repoPath, sha, content: text === undefined ? undefined : Buffer.from(text).toString('base64') }
    const response = await send(`${api}/contents`, {
      method: 'POST',
      body: JSON.stringify({ branch, message, author, files: [file] }),
    })
    const { commit } = await answer<{ commit: { sha: string, html_url?: string } }>(response)

    return { sha: commit.sha, url: commit.html_url }
  }

  return {
    async save(change) {
      try {
        return await commit(change)
      }
      catch (error) {
        throw error instanceof Error && error.name === 'TimeoutError' ? new ForgeError(504, `Forgejo did not answer within ${timeout / 1000} s`) : error
      }
    },
  }
}

// Forgejo explains a refusal in a JSON `message`; a proxy in front of it may answer anything.
async function errorMessage(response: Response): Promise<string> {
  const text = await response.text()

  try {
    return (JSON.parse(text) as { message?: string }).message ?? response.statusText
  }
  catch {
    return text || response.statusText
  }
}

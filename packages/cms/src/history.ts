import { dirname } from 'node:path'
import { repositoryRoot } from 'kay/content'

// How many commits the history of a list is read from; an entry last edited before them shows no date.
const LOG_LIMIT = 5000
// A git that takes longer is killed, and the files show no date; a list sorted by its dates waits that long for them.
const GIT_LIMIT_MS = 5000
// The walk of the history for a list may take longer, as no page waits for it past GIT_LIMIT_MS.
const LOG_LIMIT_MS = 30_000
// How long a list not sorted by its dates waits for them: a walk still running then gives them to the lists opened after it.
const EDITS_WAIT_MS = 1000

// The last edit of an entry's file: when, in milliseconds, and who by. Only git knows, so a file with no commit has none: its modification time would only say when it was checked out.
export interface Edit {
  at: number
  author?: string | undefined
}

// Reads the last edit of each file, by path relative to the repository, in one `git log` over `dir`, the collection's folder, when they all sit in it, so every page of a collection shares one walk whatever subfolders its entries sit in; `sorting` waits longer for the dates, which the order of the list needs.
export type EditReader = (paths: string[], options?: { dir?: string | undefined, sorting?: boolean | undefined }) => Promise<Map<string, Edit>>

const LEADING_NEWLINE = /^\n/u
const MARK = '\u0001'

// The walks of the history, by the folders they cover: one per commit, as only a commit changes what they read.
const walks = new Map<string, { head: string, edits: Promise<Map<string, Edit> | undefined> }>()
// Aborted when the server stops or `kay dev` reloads it, which runs the app's `onStop` hooks, so no git, a walk above all, outlives the module that started it.
let stopping = new AbortController()
// The reads of HEAD started so far, and the newest of those answered: one answering after a newer one gives the newer HEAD, as git walks whatever HEAD is by then.
let reads = 0
let newest = { read: 0, head: '' }

// Runs git in the repository and gives its output, undefined when git is missing, fails or runs out of time.
async function git(args: string[], timeout = GIT_LIMIT_MS): Promise<string | undefined> {
  try {
    const run = Bun.spawn(['git', '--literal-pathspecs', ...args], { cwd: repositoryRoot(), stdout: 'pipe', stderr: 'ignore', killSignal: 'SIGKILL', timeout, signal: stopping.signal })
    const out = await new Response(run.stdout).text()

    return await run.exited === 0 ? out : undefined
  }
  catch {
    return undefined
  }
}

// The last edit of every file the folders' last LOG_LIMIT commits touched, undefined when git could not tell.
async function logged(dirs: string[]): Promise<Map<string, Edit> | undefined> {
  const out = await git(['log', '-z', '-n', String(LOG_LIMIT), '--name-only', `--format=${MARK}%at${MARK}%an`, '--', ...dirs], LOG_LIMIT_MS)

  if (out === undefined)
    return undefined

  const edits = new Map<string, Edit>()
  const parts = out.split(MARK)

  // Parts after the first come in pairs: a commit's time, then its author and the files it touched, NUL apart.
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const [author = '', ...files] = parts[i + 1]!.split('\0')

    for (const file of files.map(name => name.replace(LEADING_NEWLINE, ''))) {
      if (file !== '' && !edits.has(file))
        edits.set(file, { at: Number(parts[i]) * 1000, author })
    }
  }

  return edits
}

// The walk for the folders at the commit checked out, started once per commit; one that failed is started again by the next list.
async function walk(dirs: string[]): Promise<Map<string, Edit> | undefined> {
  const read = ++reads
  const { signal } = stopping
  const answered = (await git(['rev-parse', 'HEAD']))?.trim()

  // A stop between the answer and this line starts no walk the stop would miss.
  if (answered === undefined || signal.aborted)
    return undefined

  if (read > newest.read)
    newest = { read, head: answered }

  const { head } = newest

  const key = JSON.stringify(dirs)
  const known = walks.get(key)

  if (known?.head === head)
    return known.edits

  for (const [other, { head: at }] of walks) {
    if (at !== head)
      walks.delete(other)
  }

  const entry = { head, edits: logged(dirs) }

  walks.set(key, entry)

  const edits = await entry.edits

  // A walk that failed is forgotten, but not one started since, after a stop killed this one.
  if (edits === undefined && walks.get(key) === entry)
    walks.delete(key)

  return edits
}

// Kills the walks still running and forgets every walk, for the server stopping or reloading.
export function stopWalks(): void {
  stopping.abort()
  stopping = new AbortController()
  walks.clear()
}

// The walk's answer, or undefined once `ms` passed.
async function soon<T>(answer: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([answer, new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, ms, undefined)
    })])
  }
  finally {
    clearTimeout(timer)
  }
}

// A file's last commit gives its time and author; a file git has no commit for, or a project outside git, gives none, and so does every file while git takes longer than a list waits, unless the list is sorted by them, which waits longer.
export const readEdits: EditReader = async (paths, { dir, sorting = false } = {}) => {
  if (paths.length === 0)
    return new Map()

  const edits = walk(dir !== undefined && paths.every(path => path.startsWith(`${dir}/`)) ? [dir] : [...new Set(paths.map(path => dirname(path)))].sort())
  const all = await soon(edits, sorting ? GIT_LIMIT_MS : EDITS_WAIT_MS)
  const found = new Map<string, Edit>()

  for (const path of paths) {
    const edit = all?.get(path)

    if (edit !== undefined)
      found.set(path, edit)
  }

  return found
}

// The last commit touching a folder, for a collection that the content list names the last edit of; undefined outside git or for a folder with no commit.
export async function readLastEdit(dir: string): Promise<Edit | undefined> {
  const out = await git(['log', '-n', '1', `--format=%at${MARK}%an`, '--', dir])
  const [time = '', author = ''] = (out ?? '').trim().split(MARK)

  return time === '' ? undefined : { at: Number(time) * 1000, author }
}

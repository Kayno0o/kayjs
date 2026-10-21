import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { repositoryRoot } from 'kay/content'

// How many commits the history of a list is read from; an entry last edited before them shows its file's modification time.
const LOG_LIMIT = 5000
// A git that takes longer is killed, and the files show their modification time.
const GIT_LIMIT_MS = 5000

// The last edit of an entry's file: when, in milliseconds, and who by when git knows.
export interface Edit {
  at: number
  author?: string | undefined
}

// Reads the last edit of each file, by path relative to the repository, in one `git log`.
export type EditReader = (paths: string[]) => Promise<Map<string, Edit>>

const LEADING_NEWLINE = /^\n/u
const MARK = '\u0001'

// Runs git in the repository and gives its output, undefined when git is missing, fails or runs out of time.
async function git(args: string[]): Promise<string | undefined> {
  try {
    const run = Bun.spawn(['git', '--literal-pathspecs', ...args], { cwd: repositoryRoot(), stdout: 'pipe', stderr: 'ignore', killSignal: 'SIGKILL', timeout: GIT_LIMIT_MS })
    const out = await new Response(run.stdout).text()

    return await run.exited === 0 ? out : undefined
  }
  catch {
    return undefined
  }
}

async function logged(paths: string[]): Promise<Map<string, Edit>> {
  const edits = new Map<string, Edit>()
  const wanted = new Set(paths)
  const out = await git(['log', '-z', '-n', String(LOG_LIMIT), '--name-only', `--format=${MARK}%at${MARK}%an`, '--', ...new Set(paths.map(path => dirname(path)))])
  const parts = (out ?? '').split(MARK)

  // Parts after the first come in pairs: a commit's time, then its author and the files it touched, NUL apart.
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const [author = '', ...files] = parts[i + 1]!.split('\0')

    for (const file of files.map(name => name.replace(LEADING_NEWLINE, ''))) {
      if (wanted.has(file) && !edits.has(file))
        edits.set(file, { at: Number(parts[i]) * 1000, author })
    }
  }

  const root = repositoryRoot()

  await Promise.all(paths.filter(path => !edits.has(path)).map(async (path) => {
    try {
      edits.set(path, { at: (await stat(join(root, path))).mtimeMs })
    }
    catch {}
  }))

  return edits
}

// A file's last commit gives its time and author, else its modification time gives the time alone; a project outside git has the second only.
export const readEdits: EditReader = async (paths) => {
  return paths.length === 0 ? new Map() : logged(paths)
}

// The last commit touching a folder, for a collection that the content list names the last edit of; undefined outside git or for a folder with no commit.
export async function readLastEdit(dir: string): Promise<Edit | undefined> {
  const out = await git(['log', '-n', '1', `--format=%at${MARK}%an`, '--', dir])
  const [time = '', author = ''] = (out ?? '').trim().split(MARK)

  return time === '' ? undefined : { at: Number(time) * 1000, author }
}

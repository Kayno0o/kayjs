import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { repositoryRoot } from 'kay/content'

// How many commits the history of a list is read from; an entry last edited before them shows its file's modification time.
const LOG_LIMIT = 5000

// The last edit of an entry's file: when, in milliseconds, and who by when git knows.
export interface Edit {
  at: number
  author?: string | undefined
}

// Reads the last edit of each file, by path relative to the repository, in one `git log`.
export type EditReader = (paths: string[]) => Promise<Map<string, Edit>>

const MARK = '\u0001'

// A file's last commit gives its time and author, else its modification time gives the time alone; a project outside git has the second only.
export const readEdits: EditReader = async (paths) => {
  const edits = new Map<string, Edit>()

  if (paths.length === 0)
    return edits

  const root = repositoryRoot()
  const wanted = new Set(paths)

  try {
    const git = Bun.spawn(['git', '-c', 'core.quotepath=false', 'log', '-n', String(LOG_LIMIT), '--name-only', `--format=${MARK}%ct${MARK}%an`, '--', ...new Set(paths.map(path => dirname(path)))], { cwd: root, stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(git.stdout).text()
    const parts = out.split(MARK)

    // Parts after the first come in pairs: a commit's time, then its author and the files it touched.
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const [author = '', ...files] = parts[i + 1]!.split('\n')

      for (const file of files) {
        if (wanted.has(file) && !edits.has(file))
          edits.set(file, { at: Number(parts[i]) * 1000, author })
      }
    }

    await git.exited
  }
  catch {}

  await Promise.all(paths.filter(path => !edits.has(path)).map(async (path) => {
    try {
      edits.set(path, { at: (await stat(join(root, path))).mtimeMs })
    }
    catch {}
  }))

  return edits
}

// The last commit touching a folder, for a collection that the content list names the last edit of; undefined outside git or for a folder with no commit.
export async function readLastEdit(dir: string): Promise<Edit | undefined> {
  try {
    const git = Bun.spawn(['git', 'log', '-n', '1', `--format=%ct${MARK}%an`, '--', dir], { cwd: repositoryRoot(), stdout: 'pipe', stderr: 'ignore' })
    const [time = '', author = ''] = (await new Response(git.stdout).text()).trim().split(MARK)

    await git.exited

    return time === '' ? undefined : { at: Number(time) * 1000, author }
  }
  catch {
    return undefined
  }
}

// What a folder's git history said at one HEAD: the last commit date of each file under it by path relative to the folder, and when it was read, so a file edited since is told apart.
interface History {
  head: string
  at: number
  dates: Map<string, Date>
}

const histories = new Map<string, History>()

// The git processes started so far, for a test of how often a load asks git.
export const gitSpawns = { count: 0 }

async function git(folder: string, args: string[]): Promise<string | undefined> {
  gitSpawns.count++

  try {
    const run = Bun.spawn(['git', '-c', 'core.quotepath=off', ...args], { cwd: folder, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const output = await new Response(run.stdout).text()

    return await run.exited === 0 ? output : undefined
  }
  catch {
    // No git binary, or a folder that is gone.
    return undefined
  }
}

// The last commit date of each file under a folder, from one `git log` for all of them, kept for the folder while HEAD stays where it was; nothing outside a repository, without git or with no commit.
async function history(folder: string): Promise<History | undefined> {
  const head = (await git(folder, ['rev-parse', 'HEAD']))?.trim()

  if (head === undefined || head === '')
    return undefined

  const kept = histories.get(folder)

  if (kept?.head === head)
    return kept

  const at = Date.now()
  const output = await git(folder, ['log', '--format=%x00%aI', '--name-only', '--no-renames', '--relative', '--', '.'])

  if (output === undefined)
    return undefined

  const dates = new Map<string, Date>()

  // Newest commit first, so the first commit naming a file is its last change.
  for (const block of output.split('\0').slice(1)) {
    const [stamp, ...files] = block.split('\n')
    const date = new Date(stamp!)

    for (const file of files) {
      if (file !== '' && !dates.has(file) && !Number.isNaN(date.getTime()))
        dates.set(file, date)
    }
  }

  const read = { head, at, dates }

  histories.set(folder, read)

  return read
}

// When each entry last changed, as ISO text by its file: its last commit for `'git'`, its file time for `'mtime'`, for a file git does not know and for one edited since git was read.
export async function modifiedTimes(mode: 'mtime' | 'git', folder: string, files: Map<string, { name: string, mtime: number }>): Promise<Map<string, string>> {
  const read = mode === 'git' ? await history(folder) : undefined

  return new Map([...files].map(([file, { name, mtime }]) => {
    const committed = read === undefined || mtime > read.at ? undefined : read.dates.get(name)

    return [file, (committed ?? new Date(mtime)).toISOString()]
  }))
}

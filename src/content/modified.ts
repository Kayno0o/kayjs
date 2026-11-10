// The last commit date of each file under a folder, by path relative to it, from one `git log` for all of them; empty outside a repository, without git or with no commit.
export async function gitDates(folder: string): Promise<Map<string, Date>> {
  const dates = new Map<string, Date>()

  try {
    const run = Bun.spawn(['git', '-c', 'core.quotepath=off', 'log', '--format=%x00%cI', '--name-only', '--no-renames', '--relative', '--', '.'], { cwd: folder, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const output = await new Response(run.stdout).text()

    if (await run.exited !== 0)
      return dates

    // Newest commit first, so the first commit naming a file is its last change.
    for (const block of output.split('\0').slice(1)) {
      const [stamp, ...files] = block.split('\n')
      const date = new Date(stamp!)

      for (const file of files) {
        if (file !== '' && !dates.has(file) && !Number.isNaN(date.getTime()))
          dates.set(file, date)
      }
    }
  }
  catch {
    // No git binary, or a folder that is gone: every file takes its mtime.
  }

  return dates
}

// When each entry last changed, as ISO text by its file: its last commit for `'git'`, its file time for `'mtime'` and for a file git does not know.
export async function modifiedTimes(mode: 'mtime' | 'git', folder: string, files: Map<string, { name: string, mtime: number }>): Promise<Map<string, string>> {
  const committed = mode === 'git' ? await gitDates(folder) : new Map<string, Date>()

  return new Map([...files].map(([file, { name, mtime }]) => [file, (committed.get(name) ?? new Date(mtime)).toISOString()]))
}

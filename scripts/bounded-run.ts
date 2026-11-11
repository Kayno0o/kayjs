import process from 'node:process'

// Runs a command with its output dropped, in a process group of its own that is killed whole once `limitMs` has passed, so a worker the command started goes with it. Resolves with whether the limit was reached.
export async function runBounded(command: string[], limitMs: number): Promise<boolean> {
  const child = Bun.spawn(['sh', '-c', 'exec "$@" >/dev/null 2>&1', 'sh', ...command], { stdin: 'ignore', detached: true })
  let limited = false

  const timer = setTimeout(() => {
    limited = true

    try {
      process.kill(-child.pid, 'SIGKILL')
    }
    catch {
      // Already gone.
    }
  }, limitMs)

  await child.exited
  clearTimeout(timer)

  return limited
}

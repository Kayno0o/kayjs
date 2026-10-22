import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

// What `files` set, read by Bun itself in a process that loads nothing else, so quotes, expansion and comments read as they do for the tests.
function envOf(dir: string, files: string[], base: Record<string, string> = {}): Record<string, string> {
  const present = files.filter(file => existsSync(join(dir, file)))

  if (present.length === 0)
    return {}

  const read = Bun.spawnSync([process.execPath, '--no-env-file', ...present.map(file => `--env-file=${file}`), '--eval', 'process.stdout.write(JSON.stringify(process.env))'], { cwd: dir, env: base })

  if (!read.success)
    throw new Error(`kay: could not read ${present.join(', ')}: ${read.stderr.toString().trim()}`)

  return JSON.parse(read.stdout.toString()) as Record<string, string>
}

// The variables the shell gave `bun test`, before Bun added what the `.env` files hold, which Linux keeps apart.
// A `--parallel` worker starts with its coordinator's variables, `.env`'s included, so it reads the coordinator's start instead.
function shellEnv(): Record<string, string> | undefined {
  if (!existsSync('/proc/self/environ'))
    return undefined

  // A run of one file under --parallel stays in the coordinator, which is no worker though it sets BUN_TEST_WORKER_ID.
  const worker = readFileSync('/proc/self/cmdline', 'utf8').split('\0').includes('--test-worker')

  const entries = readFileSync(`/proc/${worker ? process.ppid : 'self'}/environ`, 'utf8').split('\0').filter(Boolean).map((entry): [string, string] => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)])

  return Object.fromEntries(entries)
}

// `bun test` loads the developer's `.env` as well as `.env.test` and `.env.test.local`, whatever NODE_ENV says, so a test would reach the real mail server or database it names.
// Every variable only `.env` sets is dropped: the shell's, the CI's, the test files' and an earlier preload's stay, as they were given.
export function isolateEnv(dir = process.cwd()): void {
  const names = envOf(dir, ['.env'])

  if (Object.keys(names).length === 0)
    return

  // Read again from the shell's own variables, as Bun did, so a value expanding `$HOME` or a name `.env` also sets reads the same, and a preload's change is the only difference left.
  // Without /proc, the process's variables bar `.env`'s own stand in for them.
  const shell = shellEnv()
  const outside = shell ?? Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !(entry[0] in names)))
  const read = envOf(dir, ['.env'], outside)
  const own = Object.entries(names).map(([name, plain]): [string, string] => [name, read[name] ?? plain])

  const test = envOf(dir, ['.env.test', '.env.test.local'])

  for (const [name, value] of own) {
    // A value `.env` does not give is the shell's or an earlier preload's, and Linux's record of the starting environment names the shell's.
    const kept = process.env[name] !== value || (shell !== undefined && name in shell)

    if (!(name in test) && !kept)
      delete process.env[name]
  }
}

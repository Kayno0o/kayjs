import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

// What `files` set, read by Bun itself in a process that loads nothing else, so quotes, expansion and comments read as they do for the tests.
function envOf(dir: string, files: string[]): Record<string, string> {
  const present = files.filter(file => existsSync(join(dir, file)))

  if (present.length === 0)
    return {}

  const read = Bun.spawnSync([process.execPath, '--no-env-file', ...present.map(file => `--env-file=${file}`), '--eval', 'process.stdout.write(JSON.stringify(process.env))'], { cwd: dir, env: {} })

  if (!read.success)
    throw new Error(`kay: could not read ${present.join(', ')}: ${read.stderr.toString().trim()}`)

  return JSON.parse(read.stdout.toString()) as Record<string, string>
}

// The names the shell gave `bun test`, before Bun added what the `.env` files hold, which Linux keeps apart.
// A `--parallel` worker starts with its coordinator's variables, `.env`'s included, so it reads the coordinator's start instead.
function shellEnv(): Set<string> | undefined {
  if (!existsSync('/proc/self/environ'))
    return undefined

  // A run of one file under --parallel stays in the coordinator, which is no worker though it sets BUN_TEST_WORKER_ID.
  const worker = readFileSync('/proc/self/cmdline', 'utf8').split('\0').includes('--test-worker')

  return new Set(readFileSync(`/proc/${worker ? process.ppid : 'self'}/environ`, 'utf8').split('\0').map(entry => entry.slice(0, entry.indexOf('='))))
}

// `bun test` loads the developer's `.env` as well as `.env.test` and `.env.test.local`, whatever NODE_ENV says, so a test would reach the real mail server or database it names.
// Every variable only `.env` sets is dropped: the shell's, the CI's and the test files' stay, as Bun gave them.
export function isolateEnv(dir = process.cwd()): void {
  const own = envOf(dir, ['.env'])

  if (Object.keys(own).length === 0)
    return

  const test = envOf(dir, ['.env.test', '.env.test.local'])
  const shell = shellEnv()

  for (const [name, value] of Object.entries(own)) {
    // Without Linux's record of the starting environment, a value `.env` does not give is the shell's.
    const fromShell = shell ? shell.has(name) : process.env[name] !== value

    if (!(name in test) && !fromShell)
      delete process.env[name]
  }
}

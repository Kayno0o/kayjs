import type { Command } from '../src/commands/command'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { build } from '../src/commands/build'
import { check } from '../src/commands/check'
import { runCommand } from '../src/commands/command'
import { USAGES } from '../src/commands/usages'

interface Capture {
  stdout: string[]
  stderr: string[]
}

const capturing = new AsyncLocalStorage<Capture>()
const STDOUT = ['log', 'info'] as const
const STDERR = ['error', 'warn'] as const
let installed = false

// Routes what `kay check` prints to the run that printed it, whichever run started it, so checks run together in one process without sharing a console.
function install(): void {
  if (installed)
    return

  installed = true
  // The spawned command always wrote to pipes, so never in colour; this process may sit on a terminal.
  delete process.env.FORCE_COLOR
  process.env.NO_COLOR = '1'

  for (const [methods, stream] of [[STDOUT, 'stdout'], [STDERR, 'stderr']] as const) {
    for (const name of methods) {
      const original = console[name].bind(console)

      console[name] = (...args: unknown[]) => {
        const capture = capturing.getStore()

        if (capture === undefined)
          original(...args)
        else
          capture[stream].push(`${args.map(String).join(' ')}\n`)
      }
    }
  }
}

interface Run {
  code: number
  output: string
  report: string
}

// `kay <name> <args>` run in this process: its exit code, what it printed on stderr (`output`) and on stdout (`report`), as the CLI's child process gave them.
async function kayRun(command: Command, name: 'check' | 'build', args: string[]): Promise<Run> {
  install()

  const capture: Capture = { stdout: [], stderr: [] }
  const code = await capturing.run(capture, async () => runCommand(command, args, `Usage: kay ${USAGES[name]}`))

  return { code, output: capture.stderr.join(''), report: capture.stdout.join('') }
}

// For a test of what a check reports; the few that are about the command as a program (the working directory, the environment, exit and signals) spawn it.
export async function kayCheck(args: string[]): Promise<Run> {
  return kayRun(check, 'check', args)
}

const CLI = join(import.meta.dir, '../src/cli.ts')
// The projects this process built, by the state of their sources: the process keeps the config and modules it loaded, so a build of a project whose files changed since goes to a process of its own.
const built = new Map<string, Set<string>>()
const OUTPUT = new Set(['node_modules', '.kay', 'dist', 'out', '.git'])

// The size and time of the project's files, but for what a build writes.
async function stampOf(dir: string): Promise<string> {
  const entries = (await readdir(dir, { withFileTypes: true })).filter(entry => !OUTPUT.has(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
  const parts = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)

    if (entry.isDirectory())
      return stampOf(path)

    const one = statSync(path, { throwIfNoEntry: false })

    return one === undefined ? '' : `${entry.name}:${one.mtimeMs}:${one.size}`
  }))

  return parts.join('|')
}

// `kay build` in a process of its own, as the command line runs.
export async function kayBuildSpawned(args: string[], env: Record<string, string> = { NODE_ENV: 'production' }): Promise<Run> {
  const child = Bun.spawn([process.execPath, CLI, 'build', ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  const [report, output, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, output, report }
}

// `kay build` run in this process with the environment the CLI's child process was given, a production build by default; the variables are the process's, so builds run one after another.
// A build that ends the process, such as a page calling `process.exit`, goes to `kayBuildSpawned`.
export async function kayBuild(args: string[], env: Record<string, string> = { NODE_ENV: 'production' }): Promise<Run> {
  const root = resolve(args[0]!)
  const stamp = existsSync(root) ? await stampOf(root) : ''
  const seen = built.get(root) ?? new Set<string>()

  if (seen.size > 0 && !seen.has(stamp))
    return kayBuildSpawned(args, env)

  seen.add(stamp)
  built.set(root, seen)

  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))

  Object.assign(process.env, env)

  try {
    return await kayRun(build, 'build', args)
  }
  finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined)
        delete process.env[name]
      else
        process.env[name] = value
    }
  }
}

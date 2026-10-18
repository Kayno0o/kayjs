import { AsyncLocalStorage } from 'node:async_hooks'
import { join, relative } from 'node:path'
import { check } from '../src/commands/check'
import { runCommand } from '../src/commands/command'
import { USAGES } from '../src/commands/usages'
import { cacheDir } from '../src/project'

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

// `kay check <args>` run in this process: its exit code, what it printed on stderr (`output`) and on stdout (`report`), as the CLI's child process gave them.
// For a test of what a check reports; the few that are about the command as a program (the working directory, the environment, exit and signals) spawn it.
export async function kayCheck(args: string[]): Promise<{ code: number, output: string, report: string }> {
  install()

  const capture: Capture = { stdout: [], stderr: [] }
  const code = await capturing.run(capture, async () => runCommand(check, args, `Usage: kay ${USAGES.check}`))

  return { code, output: capture.stderr.join(''), report: capture.stdout.join('') }
}

const CHECKOUT = join(import.meta.dir, '..')
const kept = new Map<string, Uint8Array>()

// A build info is only reusable by a project with the same options at the same depth below the checkout, as its file names are relative to its folder.
async function infoKey(root: string): Promise<string | undefined> {
  const config = Bun.file(join(root, 'tsconfig.json'))

  return await config.exists() ? `${relative(root, CHECKOUT)}\n${await config.text()}` : undefined
}

// What a developer's second `kay check` has and a scratch project's first lacks: tsgo's build info of an earlier project with the same options, so kay's own sources and the libraries it imports are not checked again from nothing.
// Only the first project of its options is checked cold; a project that already has a build info keeps it.
export async function warmBuildInfo(root: string): Promise<void> {
  const key = await infoKey(root)
  const file = join(cacheDir(root), 'check', 'tsbuildinfo')

  if (key === undefined || await Bun.file(file).exists())
    return

  const bytes = kept.get(key)

  if (bytes !== undefined)
    await Bun.write(file, bytes)
}

// Keeps the build info a check left, for `warmBuildInfo` to hand to the next project with the same options: the largest seen, as it knows the most files.
export async function keepBuildInfo(root: string): Promise<void> {
  const key = await infoKey(root)
  const file = Bun.file(join(cacheDir(root), 'check', 'tsbuildinfo'))

  if (key === undefined || !await file.exists())
    return

  const bytes = await file.bytes()

  if (bytes.length > (kept.get(key)?.length ?? 0))
    kept.set(key, bytes)
}

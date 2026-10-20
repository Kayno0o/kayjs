import { AsyncLocalStorage } from 'node:async_hooks'
import process from 'node:process'
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

// `kay check <args>` run in this process: its exit code, what it printed on stderr (`output`) and on stdout (`report`), as the CLI's child process gave them.
// For a test of what a check reports; the few that are about the command as a program (the working directory, the environment, exit and signals) spawn it.
export async function kayCheck(args: string[]): Promise<{ code: number, output: string, report: string }> {
  install()

  const capture: Capture = { stdout: [], stderr: [] }
  const code = await capturing.run(capture, async () => runCommand(check, args, `Usage: kay ${USAGES.check}`))

  return { code, output: capture.stderr.join(''), report: capture.stdout.join('') }
}

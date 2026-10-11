// What every command of the command line shares: how it is declared and parsed, and how it prints what it did and found.
import type { ParseArgsOptionsConfig } from 'node:util'
import type { CheckDiagnostic } from '../check'
import type { Paint } from '../compiler/frame'
import { realpathSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { colors, createColors } from '@kaynooo/utils/tools/colors'
import { formatCheckDiagnostic } from '../check'

const SHELL_SAFE = /^[\w@%+=:,./-]+$/
const PORT = /^\d{1,5}$/
// Colours a report as rustc does when stderr is a terminal that takes colours, and leaves it plain otherwise.
const stderrColors = createColors({ stream: process.stderr })

export const toStderr: Paint = (styles, text) => styles.reduce((paint, style) => paint[style], stderrColors)(text)

export interface Parsed {
  values: Record<string, string | boolean | undefined>
  positionals: string[]
}

export interface Command {
  // Its line of the usage, after `kay `.
  usage: string
  options: ParseArgsOptionsConfig
  positionals: number
  // The arguments as `parseArgs` should read them.
  normalize?: (args: string[]) => string[]
  // `refuse` prints why the arguments do not go together, then the usage, and answers the exit code.
  run: (parsed: Parsed, refuse: (reason?: string) => number) => Promise<number> | number
}

// Runs a command on its arguments, or prints the usage: to stdout for `--help`, to stderr for an option or argument the command does not take.
export async function runCommand(command: Command, args: string[], usage: string): Promise<number> {
  const refuse = (reason?: string) => {
    console.error(reason === undefined ? usage : `kay: ${reason}\n${usage}`)

    return 1
  }
  let parsed: Parsed

  try {
    const { values, positionals } = parseArgs({ args: command.normalize?.(args) ?? args, options: { ...command.options, help: { type: 'boolean', short: 'h' } }, allowPositionals: true })

    if (values.help) {
      console.log(usage)

      return 0
    }

    if (positionals.length > command.positionals)
      throw new Error(`unexpected argument ${positionals[command.positionals]}`)

    parsed = { values, positionals }
  }
  catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }

  return command.run(parsed, refuse)
}

// The directory a command works on, or nothing once it said that the path is none.
export function projectRoot(command: string, path = '.'): string | undefined {
  const root = resolve(path)

  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    warnOtherKay(command, root)

    return root
  }

  console.error(`kay ${command}: ${path} is not a directory`)

  return undefined
}

// A project importing another copy of kay than the one running the command ends up with two of kay's module states, one losing what the other set up, such as where content collections live or the head a page adds; a global `kay`, or a `.bin` link copied from another project, does that.
export function warnOtherKay(command: string, root: string): void {
  let imported: string

  try {
    imported = realpathSync(Bun.resolveSync('kay', root))
  }
  catch {
    return
  }

  const running = realpathSync(resolve(import.meta.dir, '../runtime/index.ts'))

  if (imported === running)
    return

  const own = resolve(imported, '../../..')

  console.warn(`kay ${command}: this is the kay at ${resolve(running, '../../..')}, but the project imports the one at ${own}; run the project's own, \`bun ${relative(realpathSync(root), join(own, 'src/cli.ts'))}\`, or reinstall if its node_modules/.bin/kay links elsewhere`)
}

// What a command did, on stdout so a terminal does not take it for an error: the verb in green, how long it took dimmed.
export function done(verb: string, rest: string, ms?: number): void {
  console.log(`${colors.bold.green(verb)} ${rest}${ms === undefined ? '' : colors.dim(` in ${Math.round(ms)} ms`)}`)
}

export function isPort(value: string): boolean {
  return PORT.test(value) && Number(value) <= 65_535
}

export function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? '' : 's'}`
}

// Prints problems as rustc does, then how many there are, and answers how many of those fail: the errors, and the warnings too with `denyWarnings`.
export async function printProblems(diagnostics: CheckDiagnostic[], denyWarnings = false): Promise<{ failing: number, found: number }> {
  const sources = new Map<string, string | undefined>()

  for (const diagnostic of diagnostics) {
    if (!sources.has(diagnostic.file))
      sources.set(diagnostic.file, await readSource(diagnostic.file))

    console.error(`${formatCheckDiagnostic(diagnostic, sources.get(diagnostic.file), toStderr)}\n`)
  }

  const warnings = diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length
  const errors = diagnostics.length - warnings

  if (diagnostics.length > 0)
    console.error([errors > 0 ? count(errors, 'error') : '', warnings > 0 ? `${count(warnings, 'warning')}${denyWarnings ? ', failing the check under --deny-warnings' : ''}` : ''].filter(part => part !== '').join(', '))

  return { failing: errors + (denyWarnings ? warnings : 0), found: diagnostics.length }
}

// A diagnostic can point at a file that is gone by now, such as a tsconfig tsgo could not read.
async function readSource(file: string): Promise<string | undefined> {
  try {
    return await Bun.file(file).text()
  }
  catch {
    return undefined
  }
}

// A path pasted into a shell line, quoted when it holds anything the shell would read.
export function shellQuote(path: string): string {
  return SHELL_SAFE.test(path) ? path : `'${path.replaceAll('\'', '\'\\\'\'')}'`
}

// What every command of the command line shares: how it is declared and parsed, and how it prints what it did and found.
import type { ParseArgsOptionsConfig } from 'node:util'
import type { CheckDiagnostic } from '../check'
import type { Paint } from '../compiler/frame'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { colors, createColors } from '@kaynooo/utils/tools/colors'
import { formatCheckDiagnostic } from '../check'
import { offsetAt, positionAt } from '../compiler/mapping'

const SHELL_SAFE = /^[\w@%+=:,./-]+$/
// What a workflow command's message and properties escape.
const COMMAND_DATA = /[%\r\n]/g
const COMMAND_PROPERTY = /[%\r\n:,]/g
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

// How problems are printed: as rustc does, as GitHub and Forgejo Actions annotate a diff with, or as one JSON document.
export const PROBLEM_FORMATS = ['text', 'github', 'json'] as const

export type ProblemFormat = typeof PROBLEM_FORMATS[number]

// A problem as `--format json` prints it, positions 1-based and the end just past the span.
export interface PrintedProblem {
  file: string
  line: number
  column: number
  endLine?: number | undefined
  endColumn?: number | undefined
  severity: 'error' | 'warning'
  code: string | null
  message: string
  label?: string | undefined
  note?: string | undefined
  help?: string | undefined
  related?: { line: number, column: number, label: string }[] | undefined
}

export function isProblemFormat(value: string): value is ProblemFormat {
  return (PROBLEM_FORMATS as readonly string[]).includes(value)
}

// Prints problems in `format`, then, but in JSON, how many there are, and answers how many of those fail: the errors, and the warnings too with `denyWarnings`.
export async function printProblems(diagnostics: CheckDiagnostic[], denyWarnings = false, format: ProblemFormat = 'text'): Promise<{ failing: number, found: number }> {
  const sources = new Map<string, string | undefined>()

  for (const diagnostic of diagnostics) {
    if (!sources.has(diagnostic.file))
      sources.set(diagnostic.file, await readSource(diagnostic.file))
  }

  const problems = diagnostics.map(diagnostic => printedProblem(diagnostic, sources.get(diagnostic.file), format))
  const warnings = diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length
  const errors = diagnostics.length - warnings

  if (format === 'json') {
    console.log(JSON.stringify({ errors, warnings, problems }))

    return { failing: errors + (denyWarnings ? warnings : 0), found: diagnostics.length }
  }

  for (const [index, diagnostic] of diagnostics.entries()) {
    if (format === 'github')
      console.log(workflowCommand(problems[index]!))
    else
      console.error(`${formatCheckDiagnostic(diagnostic, sources.get(diagnostic.file), toStderr)}\n`)
  }

  if (diagnostics.length > 0)
    console.error([errors > 0 ? count(errors, 'error') : '', warnings > 0 ? `${count(warnings, 'warning')}${denyWarnings ? ', failing the check under --deny-warnings' : ''}` : ''].filter(part => part !== '').join(', '))

  return { failing: errors + (denyWarnings ? warnings : 0), found: diagnostics.length }
}

// A check that could not run, on a missing path or a config that does not load: on stderr as always, and as one error in JSON or an Actions annotation, which a tool reading stdout would otherwise get nothing from.
export function printFailure(command: string, failure: unknown, format: ProblemFormat): void {
  console.error(typeof failure === 'string' ? `kay ${command}: ${failure}` : failure)

  if (format === 'text')
    return

  // Bun's error for a module that does not parse tells where.
  const { message, position } = (typeof failure === 'object' && failure !== null ? failure : {}) as { message?: unknown, position?: { file: string, line: number, column: number } | null }
  const problem = { ...position && { file: shownPath(position.file, format), line: position.line, column: position.column }, severity: 'error' as const, code: null, message: typeof failure === 'string' ? failure : typeof message === 'string' ? message : String(failure) }

  if (format === 'json')
    console.log(JSON.stringify({ errors: 1, warnings: 0, problems: [problem] }))
  else
    console.log(workflowCommand(problem))
}

// GitHub and Forgejo resolve an annotation's file from the repository's root, where the job checked it out, whatever directory the step ran in; a file outside it keeps its path from the current directory.
function shownPath(file: string, format: ProblemFormat): string {
  const workspace = format === 'github' ? process.env.GITHUB_WORKSPACE : undefined
  const fromWorkspace = workspace === undefined ? undefined : relative(workspace, file)

  return fromWorkspace === undefined || fromWorkspace === '..' || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace) ? relative(process.cwd(), file) : fromWorkspace
}

function printedProblem(diagnostic: CheckDiagnostic, source: string | undefined, format: ProblemFormat): PrintedProblem {
  const { line, column, label, note, help } = diagnostic
  const start = source === undefined ? undefined : offsetAt(source, diagnostic)
  const end = source !== undefined && diagnostic.end !== undefined ? positionAt(source, diagnostic.end) : undefined
  const related = source === undefined ? undefined : diagnostic.related?.map(place => ({ ...positionAt(source, place.start), label: place.label }))

  return {
    file: shownPath(diagnostic.file, format),
    line,
    column,
    ...end && start !== undefined && diagnostic.end! > start && { endLine: end.line, endColumn: end.column },
    severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
    code: diagnostic.code ?? null,
    message: diagnostic.message,
    ...label !== undefined && { label },
    ...note !== undefined && { note },
    ...help !== undefined && { help },
    ...related !== undefined && related.length > 0 && { related },
  }
}

// `::error file=src/a.kay,line=4,col=3,title=missing-alt::An img needs alt`, which an Actions runner shows on the diff; the note and the help go on lines of their own.
function workflowCommand(problem: Omit<PrintedProblem, 'file' | 'line' | 'column'> & Partial<Pick<PrintedProblem, 'file' | 'line' | 'column'>>): string {
  const properties = [['file', problem.file], ['line', problem.line], ['col', problem.column], ['endLine', problem.endLine], ['endColumn', problem.endColumn], ['title', problem.code ?? 'kay check']] as const
  const text = [problem.message, ...problem.note === undefined ? [] : [`note: ${problem.note}`], ...problem.help === undefined ? [] : [`help: ${problem.help}`]].join('\n')

  return `::${problem.severity} ${properties.filter(([, value]) => value !== undefined).map(([name, value]) => `${name}=${escapeCommand(String(value), COMMAND_PROPERTY)}`).join(',')}::${escapeCommand(text, COMMAND_DATA)}`
}

function escapeCommand(text: string, characters: RegExp): string {
  return text.replace(characters, character => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
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

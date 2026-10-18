// What every command of the command line shares: how it is declared and parsed, and how it prints what it did and found.
import type { ParseArgsOptionsConfig } from 'node:util'
import type { CheckDiagnostic } from '../check'
import type { Paint } from '../compiler/frame'
import type { KayConfig } from '../config'
import { Console } from 'node:console'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { colors, createColors } from '@kaynooo/utils/tools/colors'
import { errorCodeOf } from '../compiler/errors'
import { offsetAt, positionAt } from '../compiler/mapping'

const SHELL_SAFE = /^[\w@%+=:,./-]+$/
// What a workflow command's message and properties escape.
const COMMAND_DATA = /[%\r\n]/g
const COMMAND_PROPERTY = /[%\r\n:,]/g
const PORT = /^\d{1,5}$/
const LEADING_DASHES = /^-+/
const UNKNOWN_OPTION = /^Unknown option '(-[^'=]*)(?:=[^']*)?'/
const COMMAND_WORDS = /^[a-z][\w-]*(?: [a-z][\w-]*(?= [<[-]|$))*/
// What the console writes to stdout.
const STDOUT_METHODS = ['log', 'info', 'debug', 'dir', 'dirxml', 'table', 'group', 'groupCollapsed', 'groupEnd', 'count', 'countReset', 'time', 'timeEnd', 'timeLog']
// Colours a report as rustc does when stderr is a terminal that takes colours, and leaves it plain otherwise.
const stderrColors = createColors({ stream: process.stderr })

export const toStderr: Paint = (styles, text) => styles.reduce((paint, style) => paint[style], stderrColors)(text)

export interface Parsed {
  // A `multiple` option comes as an array.
  values: Record<string, string | boolean | string[] | undefined>
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

// A command a library adds to `kay` through its extension's `commands`, run in the project of the current directory, which it is given with its config.
export interface KayCommand extends Omit<Command, 'run'> {
  run: (parsed: Parsed, refuse: (reason?: string) => number, project: { root: string, config: KayConfig }) => Promise<number> | number
}

// Runs a command on its arguments, or prints its `usage`: to stdout for `--help`, to stderr for an option or argument the command does not take.
export async function runCommand(command: Command, args: string[], usage: string): Promise<number> {
  const fail = (message?: string) => {
    console.error(message === undefined ? usage : `${message}\n${usage}`)

    return 1
  }
  const refuse = (reason?: string) => fail(reason === undefined ? undefined : `kay: ${reason}`)
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
    return unknownOption(error, command, fail) ?? refuse(error instanceof Error ? error.message : String(error))
  }

  return command.run(parsed, refuse)
}

// An option the command does not take, as `kay build: unknown option --no-cache` without `parseArgs`'s hint about `--`, naming the option the command has nearest to a mistyped one.
function unknownOption(error: unknown, command: Command, fail: (message: string) => number): number | undefined {
  const unknown = error instanceof Error ? UNKNOWN_OPTION.exec(error.message)?.[1] : undefined

  if (unknown === undefined)
    return undefined

  const typed = unknown.replace(LEADING_DASHES, '')
  const [near] = [...Object.keys(command.options), 'help'].map(option => ({ option, distance: editDistance(typed, option) })).filter(({ distance }) => distance <= Math.min(2, Math.ceil(typed.length / 3))).sort((a, b) => a.distance - b.distance)

  return fail(`kay ${COMMAND_WORDS.exec(command.usage)?.[0] ?? command.usage}: unknown option ${unknown}${near === undefined || !unknown.startsWith('--') ? '' : `, did you mean --${near.option}?`}`)
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i++) {
    const next = [i]

    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))

    row = next
  }

  return row[b.length]!
}

// The directory a command works on, or nothing once it said, in `format`, that the path is none.
export function projectRoot(command: string, path = '.', format: ProblemFormat = 'text'): string | undefined {
  const root = resolve(path)

  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    warnOtherKay(command, root)

    return root
  }

  printFailure(command, `${path} is not a directory`, format)

  return undefined
}

// A project importing another copy of kay than the one running the command ends up with two of kay's module states, one losing what the other set up, such as where content collections live or the head a page adds; a global `kay`, or a `.bin` link copied from another project, does that.
export function warnOtherKay(command: string, root: string): void {
  let imported: string

  // Without a `node_modules` above it, Bun would install npm's own `kay`, another package, to resolve it: seconds of network for every command.
  if (!kayInstalledAbove(root))
    return

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

function kayInstalledAbove(root: string): boolean {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', 'kay')))
      return true

    if (dir === dirname(dir))
      return false
  }
}

// What a command did, on stdout so a terminal does not take it for an error: the verb in green, how long it took dimmed.
export function done(verb: string, rest: string, ms?: number): void {
  console.log(`${colors.bold.green(verb)} ${rest}${ms === undefined ? '' : colors.dim(` in ${Math.round(ms)} ms`)}`)
}

// Whether a redrawn line or a cleared screen may go to `stream`: a terminal, unless `NO_COLOR` or a dumb terminal asks for plain text; `FORCE_COLOR` brings colour to a pipe but never these, which would garble it.
export function takesControlCodes(stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): boolean {
  return stream.isTTY === true && env.NO_COLOR === undefined && env.NODE_DISABLE_COLORS === undefined && env.TERM !== 'dumb'
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

// A problem that may lie in no file, as what stops a command does.
export type FailureProblem = Omit<PrintedProblem, 'file' | 'line' | 'column'> & Partial<Pick<PrintedProblem, 'file' | 'line' | 'column'>>

// `--format`, `text` when not given, among the `formats` the command prints in: undefined, once said which it takes, for another.
export function formatOption(command: string, value: Parsed['values'][string], formats: readonly ProblemFormat[] = ['text', 'json']): ProblemFormat | undefined {
  const format = typeof value === 'string' ? value : 'text'

  if ((formats as readonly string[]).includes(format))
    return format as ProblemFormat

  console.error(`kay ${command}: --format takes ${formats.map(name => `\`${name}\``).join(', ')}, not \`${format}\``)

  return undefined
}

// The problems as `--format json` and `github` print them, each file read once.
export async function printedProblems(diagnostics: CheckDiagnostic[], format: ProblemFormat = 'json'): Promise<PrintedProblem[]> {
  const sources = await diagnosticSources(diagnostics)

  return diagnostics.map(diagnostic => printedProblem(diagnostic, sources.get(diagnostic.file), format))
}

export function problemCounts(problems: { severity: 'error' | 'warning' }[]): { errors: number, warnings: number } {
  const warnings = problems.filter(problem => problem.severity === 'warning').length

  return { errors: problems.length - warnings, warnings }
}

// A command's whole answer under `--format json`, alone on stdout and on one line.
export function printDocument(document: object): void {
  console.log(JSON.stringify(document))
}

// Prints problems in `format`, then, but in JSON, how many there are, and answers how many of those fail: the errors, and the warnings too with `denyWarnings`.
export async function printProblems(diagnostics: CheckDiagnostic[], denyWarnings = false, format: ProblemFormat = 'text'): Promise<{ failing: number, found: number }> {
  const sources = await diagnosticSources(diagnostics)
  const problems = diagnostics.map(diagnostic => printedProblem(diagnostic, sources.get(diagnostic.file), format))
  const { errors, warnings } = problemCounts(problems)

  if (format === 'json') {
    printDocument({ errors, warnings, problems })

    return { failing: errors + (denyWarnings ? warnings : 0), found: diagnostics.length }
  }

  const { formatCheckDiagnostic } = await import('../check')

  for (const [index, diagnostic] of diagnostics.entries()) {
    if (format === 'github')
      console.log(workflowCommand(problems[index]!))
    else
      console.error(`${formatCheckDiagnostic(diagnostic, sources.get(diagnostic.file), toStderr)}\n`)
  }

  if (diagnostics.length > 0)
    console.error([errors > 0 ? count(errors, 'error') : '', warnings > 0 ? `${count(warnings, 'warning')}${denyWarnings ? ', failing under --deny-warnings' : ''}` : ''].filter(part => part !== '').join(', '))

  return { failing: errors + (denyWarnings ? warnings : 0), found: diagnostics.length }
}

// A command that could not run, on a missing path or a config that does not load: on stderr as always, and as one error in JSON or an Actions annotation, which a tool reading stdout would otherwise get nothing from.
// A failure given as text is a usage problem, `command-usage`, unless `code` says otherwise: null for a child that died.
export function printFailure(command: string, failure: unknown, format: ProblemFormat, code?: string | null): void {
  console.error(typeof failure === 'string' ? `kay ${command}: ${failure}` : failure)

  const hint = explainHint(failure)

  if (hint !== undefined)
    console.error(hint)

  if (format === 'json')
    printDocument({ errors: 1, warnings: 0, problems: [failureProblem(failure, format, code)] })
  else if (format === 'github')
    console.log(workflowCommand(failureProblem(failure, format, code), command))
}

// What stopped a command as a problem, with the code of the error kay raised if it did, placed where Bun's error for a module that does not parse tells.
export function failureProblem(failure: unknown, format: ProblemFormat, code: string | null = failureCode(failure)): FailureProblem {
  const { message, position } = (typeof failure === 'object' && failure !== null ? failure : {}) as { message?: unknown, position?: { file: string, line: number, column: number } | null }

  return { ...position && { file: shownPath(position.file, format), line: position.line, column: position.column }, severity: 'error', code, message: failureText(failure, message) }
}

function failureText(failure: unknown, message: unknown): string {
  if (typeof failure === 'string')
    return failure

  return typeof message === 'string' ? message.trim() : String(failure)
}

function failureCode(failure: unknown): string | null {
  return typeof failure === 'string' ? 'command-usage' : errorCodeOf(failure) ?? null
}

// The line telling where an error kay raised is explained.
export function explainHint(failure: unknown): string | undefined {
  const code = errorCodeOf(failure)

  return code === undefined ? undefined : `kay explain ${code} says where the fix is written`
}

// Runs `run` with what it and the code it loads print to stdout sent to stderr, so stdout keeps the one document a format gives it.
export async function withStdoutOnStderr<T>(run: () => Promise<T>): Promise<T> {
  const toStderr = new Console({ stdout: process.stderr, stderr: process.stderr })
  const saved = STDOUT_METHODS.map(name => [name, Reflect.get(console, name)] as const)
  const write: unknown = Reflect.get(process.stdout, 'write')

  for (const name of STDOUT_METHODS)
    Reflect.set(console, name, (Reflect.get(toStderr, name) as (...args: unknown[]) => void).bind(toStderr))

  Reflect.set(process.stdout, 'write', process.stderr.write.bind(process.stderr))

  try {
    return await run()
  }
  finally {
    for (const [name, method] of saved)
      Reflect.set(console, name, method)

    Reflect.set(process.stdout, 'write', write)
  }
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
export function workflowCommand(problem: FailureProblem, command = 'check'): string {
  const properties = [['file', problem.file], ['line', problem.line], ['col', problem.column], ['endLine', problem.endLine], ['endColumn', problem.endColumn], ['title', problem.code === null || problem.code === 'command-usage' ? `kay ${command}` : problem.code]] as const
  const text = [problem.message, ...problem.note === undefined ? [] : [`note: ${problem.note}`], ...problem.help === undefined ? [] : [`help: ${problem.help}`]].join('\n')

  return `::${problem.severity} ${properties.filter(([, value]) => value !== undefined).map(([name, value]) => `${name}=${escapeCommand(String(value), COMMAND_PROPERTY)}`).join(',')}::${escapeCommand(text, COMMAND_DATA)}`
}

function escapeCommand(text: string, characters: RegExp): string {
  return text.replace(characters, character => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

async function diagnosticSources(diagnostics: CheckDiagnostic[]): Promise<Map<string, string | undefined>> {
  const sources = new Map<string, string | undefined>()

  for (const diagnostic of diagnostics) {
    if (!sources.has(diagnostic.file))
      sources.set(diagnostic.file, await readSource(diagnostic.file))
  }

  return sources
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

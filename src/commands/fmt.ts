import type { Command, ProblemFormat } from './command'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { fromCompile } from '../check/shadow-types'
import { formatDiagnostic } from '../compiler'
import { formatFiles, formatSource } from '../format'
import { count, done, formatOption, printDocument, printedProblems, printFailure, problemCounts, toStderr } from './command'
import { USAGES } from './usages'

// `--from-html`: the HTML in a file, or on stdin, printed as a `.kay` template, what could not be translated listed on stderr.
async function fromHtml(paths: string[], check: boolean, format: ProblemFormat): Promise<number> {
  if (check || paths.length > 1) {
    printFailure('fmt', check ? '--from-html prints a template and has nothing to check' : '--from-html reads one file, or stdin', format)

    return 1
  }

  try {
    const [path] = paths
    const { htmlToKay } = await import('../migrate/html')
    const { code, notes } = htmlToKay(await (path === undefined || path === '-' ? Bun.stdin.text() : Bun.file(path).text()))

    if (format === 'json') {
      printDocument({ code, notes })

      return 0
    }

    process.stdout.write(code)

    for (const note of notes)
      console.error(`line ${note.line}: ${note.message}`)

    return 0
  }
  catch (error) {
    printFailure('fmt', error instanceof Error ? error.message : error, format)

    return 1
  }
}

// `--stdin`: the source on stdin formatted to stdout, for an editor's formatter. `path` names the file it is for, which decides the Tailwind order of the classes; the source is left alone and the problems go to stderr when it does not compile.
async function fromStdin(paths: string[], refused: string | undefined, format: ProblemFormat): Promise<number> {
  if (refused !== undefined || paths.length > 1) {
    printFailure('fmt', refused ?? '--stdin reads one source, and takes the path of the file it is for', format)

    return 1
  }

  try {
    const file = resolve(paths[0] ?? 'stdin.kay')
    const source = await Bun.stdin.text()
    const { code, diagnostics } = await formatSource(source, file)

    if (diagnostics.length > 0) {
      for (const diagnostic of diagnostics)
        console.error(`${formatDiagnostic(source, relative(process.cwd(), file), diagnostic, toStderr)}\n`)

      return 1
    }

    process.stdout.write(code)

    return 0
  }
  catch (error) {
    printFailure('fmt', error instanceof Error ? error.message : error, format)

    return 1
  }
}

// Why `--stdin` cannot go with the other options given, if it cannot.
function stdinClash(values: { 'check'?: boolean, 'from-html'?: boolean }, format: ProblemFormat): string | undefined {
  if (values['from-html'] === true)
    return '--stdin and --from-html each read a source'

  if (values.check === true)
    return '--stdin prints the formatted source and has nothing to check'

  return format === 'json' ? '--stdin prints the formatted source, not a document' : undefined
}

// Formats in place; with `--check` lists the files that are not formatted and fails, with `--dry-run` lists them and succeeds.
export const fmt: Command = {
  usage: USAGES.fmt,
  options: { 'check': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'from-html': { type: 'boolean' }, 'stdin': { type: 'boolean' }, 'format': { type: 'string' }, 'quiet': { type: 'boolean' } },
  positionals: Infinity,
  run: async ({ values, positionals: paths }, refuse) => {
    const verify = values.check === true

    if (verify && values['dry-run'] === true)
      return refuse('--check fails on an unformatted file and --dry-run lists them and succeeds: take one')

    const write = !verify && values['dry-run'] !== true
    const format = formatOption('fmt', values.format)
    let result: Awaited<ReturnType<typeof formatFiles>>

    if (format === undefined)
      return 1

    if (values.stdin === true) {
      return fromStdin(paths, stdinClash(values, format), format)
    }

    if (values['from-html'] === true)
      return fromHtml(paths, values.check === true, format)

    try {
      result = await formatFiles(paths.length > 0 ? paths : ['.'], { write })
    }
    catch (error) {
      printFailure('fmt', error instanceof Error ? error.message : error, format)

      return 1
    }

    const { changed, errors } = result
    const failed = errors.length > 0 || (verify && changed.length > 0)

    if (format === 'json') {
      const problems = await printedProblems(errors.flatMap(({ file, source, diagnostics }) => diagnostics.map(diagnostic => fromCompile(file, source, diagnostic))))

      printDocument({ ...problemCounts(problems), problems, written: write, changed: changed.map(file => relative(process.cwd(), file)) })

      return failed ? 1 : 0
    }

    for (const { file, source, diagnostics } of errors) {
      for (const diagnostic of diagnostics)
        console.error(`${formatDiagnostic(source, relative(process.cwd(), file), diagnostic, toStderr)}\n`)
    }

    // Quiet, the files formatted are counted, those left unformatted still named.
    if (write && values.quiet === true && changed.length > 0)
      done('formatted', count(changed.length, 'file'))

    for (const file of changed) {
      if (verify)
        console.error(`not formatted: ${relative(process.cwd(), file)}`)
      else if (!write)
        done('would format', relative(process.cwd(), file))
      else if (values.quiet !== true)
        done('formatted', relative(process.cwd(), file))
    }

    if (changed.length === 0 && errors.length === 0)
      done('checked', 'every file is formatted')

    return failed ? 1 : 0
  },
}

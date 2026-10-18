import type { Command, ProblemFormat } from './command'
import { relative } from 'node:path'
import process from 'node:process'
import { fromCompile } from '../check/shadow-types'
import { formatDiagnostic } from '../compiler'
import { formatFiles } from '../format'
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

// Formats in place, or with `--check` lists the files that are not formatted and fails.
export const fmt: Command = {
  usage: USAGES.fmt,
  options: { 'check': { type: 'boolean' }, 'from-html': { type: 'boolean' }, 'format': { type: 'string' }, 'quiet': { type: 'boolean' } },
  positionals: Infinity,
  run: async ({ values, positionals: paths }) => {
    const write = values.check !== true
    const format = formatOption('fmt', values.format)
    let result: Awaited<ReturnType<typeof formatFiles>>

    if (format === undefined)
      return 1

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
    const failed = errors.length > 0 || (!write && changed.length > 0)

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
      if (!write)
        console.error(`not formatted: ${relative(process.cwd(), file)}`)
      else if (values.quiet !== true)
        done('formatted', relative(process.cwd(), file))
    }

    if (changed.length === 0 && errors.length === 0)
      done('checked', 'every file is formatted')

    return failed ? 1 : 0
  },
}

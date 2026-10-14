import type { Command } from './command'
import { relative } from 'node:path'
import process from 'node:process'
import { fromCompile } from '../check/shadow-types'
import { formatDiagnostic } from '../compiler'
import { formatFiles } from '../format'
import { done, formatOption, printDocument, printedProblems, printFailure, problemCounts, toStderr } from './command'

// Formats in place, or with `--check` lists the files that are not formatted and fails.
export const fmt: Command = {
  usage: 'fmt [paths...] [--check] [--format text|json]',
  options: { check: { type: 'boolean' }, format: { type: 'string' } },
  positionals: Infinity,
  run: async ({ values, positionals: paths }) => {
    const write = values.check !== true
    const format = formatOption('fmt', values.format)
    let result: Awaited<ReturnType<typeof formatFiles>>

    if (format === undefined)
      return 1

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

    for (const file of changed) {
      if (write)
        done('formatted', relative(process.cwd(), file))
      else
        console.error(`not formatted: ${relative(process.cwd(), file)}`)
    }

    if (changed.length === 0 && errors.length === 0)
      done('checked', 'every file is formatted')

    return failed ? 1 : 0
  },
}

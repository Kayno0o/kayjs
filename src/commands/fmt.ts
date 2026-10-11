import type { Command } from './command'
import { relative } from 'node:path'
import process from 'node:process'
import { formatDiagnostic } from '../compiler'
import { formatFiles } from '../format'
import { done, toStderr } from './command'

// Formats in place, or with `--check` lists the files that are not formatted and fails.
export const fmt: Command = {
  usage: 'fmt [paths...] [--check]',
  options: { check: { type: 'boolean' } },
  positionals: Infinity,
  run: async ({ values, positionals: paths }) => {
    const write = values.check !== true
    let result: Awaited<ReturnType<typeof formatFiles>>

    try {
      result = await formatFiles(paths.length > 0 ? paths : ['.'], { write })
    }
    catch (error) {
      console.error(error instanceof Error ? error.message : error)

      return 1
    }

    const { changed, errors } = result

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

    return errors.length > 0 || (!write && changed.length > 0) ? 1 : 0
  },
}

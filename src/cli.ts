#!/usr/bin/env bun
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { check, formatCheckDiagnostic } from './check'
import { formatDiagnostic } from './compiler'
import { formatFiles } from './format'
import { startServer } from './lsp/server'

const USAGE = 'Usage: kay check [dir] [-p tsconfig.json]\n       kay fmt [paths...] [--check]\n       kay lsp --stdio'

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args

  if (command === 'lsp') {
    await startServer(Bun.stdin.stream(), data => void process.stdout.write(data))

    return 0
  }

  if (command === 'fmt')
    return fmt(rest)

  if (command !== 'check') {
    console.error(USAGE)

    return 1
  }

  const projectFlag = rest.indexOf('-p')
  const tsconfig = projectFlag === -1 ? 'tsconfig.json' : rest[projectFlag + 1]
  const dir = rest.find((arg, index) => !arg.startsWith('-') && index !== projectFlag + 1) ?? '.'

  if (!tsconfig) {
    console.error(USAGE)

    return 1
  }

  const diagnostics = await check(resolve(dir), { tsconfig })

  for (const diagnostic of diagnostics)
    console.error(formatCheckDiagnostic(diagnostic))

  if (diagnostics.length > 0)
    console.error(`\n${diagnostics.length} error${diagnostics.length === 1 ? '' : 's'}`)

  return diagnostics.length > 0 ? 1 : 0
}

// Formats in place, or with `--check` lists the files that are not formatted and fails.
async function fmt(args: string[]): Promise<number> {
  const write = !args.includes('--check')
  const paths = args.filter(arg => !arg.startsWith('-'))
  const { changed, errors } = await formatFiles(paths.length > 0 ? paths : ['.'], { write })

  for (const { file, source, diagnostics } of errors) {
    for (const diagnostic of diagnostics)
      console.error(formatDiagnostic(source, relative(process.cwd(), file), diagnostic))
  }

  for (const file of changed)
    console.error(`${write ? 'formatted' : 'not formatted'}: ${relative(process.cwd(), file)}`)

  return errors.length > 0 || (!write && changed.length > 0) ? 1 : 0
}

process.exit(await main(process.argv.slice(2)))

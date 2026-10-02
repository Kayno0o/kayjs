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
  const dir = rest.find((arg, index) => !arg.startsWith('-') && (projectFlag === -1 || index !== projectFlag + 1)) ?? '.'

  if (!tsconfig) {
    console.error(USAGE)

    return 1
  }

  const diagnostics = await check(resolve(dir), { tsconfig })

  const sources = new Map<string, string | undefined>()

  for (const diagnostic of diagnostics) {
    if (!sources.has(diagnostic.file))
      sources.set(diagnostic.file, await readSource(diagnostic.file))

    console.error(`${formatCheckDiagnostic(diagnostic, sources.get(diagnostic.file))}\n`)
  }

  if (diagnostics.length > 0)
    console.error(`${diagnostics.length} error${diagnostics.length === 1 ? '' : 's'}`)

  return diagnostics.length > 0 ? 1 : 0
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

// Formats in place, or with `--check` lists the files that are not formatted and fails.
async function fmt(args: string[]): Promise<number> {
  const write = !args.includes('--check')
  const paths = args.filter(arg => !arg.startsWith('-'))
  const { changed, errors } = await formatFiles(paths.length > 0 ? paths : ['.'], { write })

  for (const { file, source, diagnostics } of errors) {
    for (const diagnostic of diagnostics)
      console.error(`${formatDiagnostic(source, relative(process.cwd(), file), diagnostic)}\n`)
  }

  for (const file of changed)
    console.error(`${write ? 'formatted' : 'not formatted'}: ${relative(process.cwd(), file)}`)

  return errors.length > 0 || (!write && changed.length > 0) ? 1 : 0
}

process.exit(await main(process.argv.slice(2)))

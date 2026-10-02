#!/usr/bin/env bun
import { resolve } from 'node:path'
import process from 'node:process'
import { check, formatCheckDiagnostic } from './check'
import { startServer } from './lsp/server'

const USAGE = 'Usage: kay check [dir] [-p tsconfig.json]\n       kay lsp --stdio'

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args

  if (command === 'lsp') {
    await startServer(Bun.stdin.stream(), data => void process.stdout.write(data))

    return 0
  }

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

process.exit(await main(process.argv.slice(2)))

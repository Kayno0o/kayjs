import type { IslandCause } from '../compiler/island-cause'
import type { ProblemFormat } from './command'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { findKayFiles } from '../build/files'
import { isPageFile } from '../build/page-dirs'
import { importedSignals } from '../build/signals'
import { compileKay } from '../compiler'
import { formatDiagnostic } from '../compiler/frame'
import { CAUSE_KINDS, describeCause, ISLAND_RULE } from '../compiler/island-cause'
import { projectPaths } from '../project'
import { printDocument, printFailure, projectRoot } from './command'

type Role = 'island' | 'static'

interface Explained {
  file: string
  role: Role
  cause?: { kind: string, name: string, line: number, description: string, meaning: string } | undefined
}

const ROLE_WORDS: Record<Role, string> = {
  island: 'an island: it renders on the server and hydrates in the browser',
  static: 'static: it ships no JavaScript',
}

function shown(cause: IslandCause) {
  return { kind: cause.kind, name: cause.name, line: cause.line, description: describeCause(cause), meaning: CAUSE_KINDS[cause.kind] }
}

// The role of each file, as `compileKay` decides it, with what decides it, and the files that do not compile, which have no role.
async function explained(root: string, files: string[]): Promise<{ found: Explained[], broken: string[] }> {
  const found: Explained[] = []
  const broken: string[] = []

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const { island, cause, diagnostics } = compileKay(source, file, { root, importedSignals: importedSignals(file, source), page: isPageFile(file, [projectPaths(root).routes]) ? true : undefined })
    const error = diagnostics.find(diagnostic => diagnostic.severity !== 'warning')

    if (error !== undefined) {
      broken.push(formatDiagnostic(source, relative(root, file), error))

      continue
    }

    found.push({ file: relative(root, file), role: island === undefined ? 'static' : 'island', ...cause && { cause: shown(cause) } })
  }

  return { found, broken }
}

function lines(entry: Explained): string[] {
  return [
    `${entry.file}: ${ROLE_WORDS[entry.role]}`,
    ...entry.cause === undefined ? [] : [`  cause: ${entry.cause.description}`, `  meaning: ${entry.cause.meaning}`],
  ]
}

// `kay explain island [file]`: the role of one component and what decides it, or every island of the project; the rule beside it.
export async function explainIsland(file: string | undefined, format: ProblemFormat): Promise<number> {
  const root = projectRoot('explain', '.', format)

  if (root === undefined)
    return 1

  if (file !== undefined) {
    const path = resolve(file)

    if (!path.endsWith('.kay') || !existsSync(path)) {
      printFailure('explain', `\`${file}\` is no .kay file of this project`, format)

      return 1
    }

    const { found: [entry], broken } = await explained(root, [path])

    if (entry === undefined) {
      printFailure('explain', broken[0]!, format)

      return 1
    }

    if (format === 'json')
      printDocument({ rule: ISLAND_RULE, ...entry })
    else
      console.log([...lines(entry), `  rule: ${ISLAND_RULE}`].join('\n'))

    return 0
  }

  const { found, broken } = await explained(root, await findKayFiles(root, { project: true, ownOnly: true, ownKayOnly: true }))
  const islands = found.filter(entry => entry.role !== 'static').sort((a, b) => a.file.localeCompare(b.file))

  if (format === 'json')
    printDocument({ rule: ISLAND_RULE, islands, ...broken.length > 0 && { broken } })
  else
    console.log([ISLAND_RULE, '', ...islands.length === 0 ? ['No component of this project is an island.'] : islands.flatMap(lines)].join('\n'))

  for (const problem of broken)
    console.error(problem)

  return broken.length === 0 ? 0 : 1
}

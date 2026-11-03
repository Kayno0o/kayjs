import type { IslandCause } from '../compiler/island-cause'
import type { ProblemFormat } from './command'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import process from 'node:process'
import { findKayFiles } from '../build/files'
import { importedSignals } from '../build/signals'
import { compileKay, ROUTE_FILES } from '../compiler'
import { CAUSE_KINDS, describeCause, ISLAND_RULE } from '../compiler/island-cause'

import { printDocument, printFailure } from './command'

type Role = 'island' | 'promoted' | 'static' | 'route'

interface Explained {
  file: string
  role: Role
  cause?: { kind: string, name: string, line: number, description: string, meaning: string } | undefined
}

const ROLE_WORDS: Record<Role, string> = {
  island: 'an island: it renders on the server and hydrates in the browser',
  promoted: 'static, and an island only when a page passes it what only an island sends',
  static: 'static: it ships no JavaScript',
  route: 'a layout or special page: the server renders it and it is never an island',
}

function shown(cause: IslandCause) {
  return { kind: cause.kind, name: cause.name, line: cause.line, description: describeCause(cause), meaning: CAUSE_KINDS[cause.kind] }
}

function roleOf(route: boolean, island: string | undefined, promote: string | undefined): Role {
  if (route)
    return 'route'

  if (island !== undefined)
    return 'island'

  return promote === undefined ? 'static' : 'promoted'
}

// The role of each file, as the build decides it, with what decides it.
async function explained(root: string, files: string[]): Promise<Explained[]> {
  const found: Explained[] = []

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const { island, promote, cause } = compileKay(source, file, { root, importedSignals: importedSignals(file, source) })
    const route = ROUTE_FILES.has(basename(file))
    const role = roleOf(route, island, promote)

    found.push({ file: relative(root, file), role, ...role !== 'route' && cause && { cause: shown(cause) } })
  }

  return found
}

function lines(entry: Explained): string[] {
  return [
    `${entry.file}: ${ROLE_WORDS[entry.role]}`,
    ...entry.cause === undefined ? [] : [`  cause: ${entry.cause.description}`, `  meaning: ${entry.cause.meaning}`],
  ]
}

// `kay explain island [file]`: the role of one component and what decides it, or every island of the project; the rule beside it.
export async function explainIsland(file: string | undefined, format: ProblemFormat): Promise<number> {
  const root = process.cwd()

  if (file !== undefined) {
    const path = resolve(file)

    if (!path.endsWith('.kay') || !existsSync(path)) {
      printFailure('explain', `\`${file}\` is no .kay file of this project`, format)

      return 1
    }

    const [entry] = await explained(root, [path])

    if (format === 'json')
      printDocument({ rule: ISLAND_RULE, ...entry })
    else
      console.log([...lines(entry!), `  rule: ${ISLAND_RULE}`].join('\n'))

    return 0
  }

  const all = await explained(root, await findKayFiles(root, { project: true, ownOnly: true, ownKayOnly: true }))
  const islands = all.filter(entry => entry.role === 'island' || entry.role === 'promoted').sort((a, b) => a.file.localeCompare(b.file))

  if (format === 'json')
    printDocument({ rule: ISLAND_RULE, islands })
  else
    console.log([ISLAND_RULE, '', ...islands.length === 0 ? ['No component of this project is an island.'] : islands.flatMap(lines)].join('\n'))

  return 0
}

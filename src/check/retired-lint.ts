import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel, RETIRED_LINTS } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { CONFIG_FILE } from '../config'
import { walk } from './ast'

const KAY_FILE = /\.kay$/
const ALLOW = /\/\/[ \t]*kay-allow(?:-file)?[ \t]+([\w-]+(?:[ \t]*,[ \t]*[\w-]+)*)/g
const NAME = /[\w-]+/g
const LEADING_COMMA = /^\s*,/

interface Edit {
  start: number
  end: number
  text: string
}

export function keyOf(property: t.ObjectProperty): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'StringLiteral' ? property.key.value : undefined
}

// The `// kay-allow` comments of a source naming `name`: the span of the name and the edit that removes it, the whole comment (and its line, when it stands alone) when it names nothing else, else the name with a comma beside it.
function allowComments(source: string, name: string): { start: number, end: number, edit: Edit }[] {
  const found: { start: number, end: number, edit: Edit }[] = []

  for (const comment of source.matchAll(ALLOW)) {
    const names = [...comment[1]!.matchAll(NAME)]
    const at = names.findIndex(candidate => candidate[0] === name)

    if (at === -1)
      continue

    const listStart = comment.index + comment[0].length - comment[1]!.length
    const start = listStart + names[at]!.index
    const end = start + name.length
    let edit: Edit

    if (names.length === 1) {
      const lineStart = source.lastIndexOf('\n', comment.index - 1) + 1
      const lineEnd = source.indexOf('\n', comment.index)
      const before = source.slice(lineStart, comment.index)
      const commentStart = comment.index - (before.length - before.trimEnd().length)

      // The rest of the line is the comment's reason, which goes with it.
      edit = before.trim() === '' ? { start: lineStart, end: lineEnd === -1 ? source.length : lineEnd + 1, text: '' } : { start: commentStart, end: lineEnd === -1 ? source.length : lineEnd, text: '' }
    }
    else if (at === 0) {
      edit = { start, end: listStart + names[1]!.index, text: '' }
    }
    else {
      edit = { start: listStart + names[at - 1]!.index + names[at - 1]![0].length, end, text: '' }
    }

    found.push({ start, end, edit })
  }

  return found
}

// A `lints` entry of the config naming `name`, with the edit that removes it and the comma that follows it, or the one before it when it is last.
function configEntries(source: string, name: string): { start: number, end: number, edit: Edit }[] {
  let ast: t.File

  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
  }
  catch {
    return []
  }

  const found: { start: number, end: number, edit: Edit }[] = []

  walk(ast, (node) => {
    if (node.type !== 'ObjectProperty' || keyOf(node) !== 'lints' || node.value.type !== 'ObjectExpression')
      return

    const properties = node.value.properties

    for (const [index, property] of properties.entries()) {
      if (property.type !== 'ObjectProperty' || keyOf(property) !== name)
        continue

      const next = properties[index + 1]
      const previous = properties[index - 1]
      // The only entry goes with its trailing comma, if any.
      const lone = LEADING_COMMA.exec(source.slice(property.end!))?.[0].length ?? 0
      const edit = next === undefined && previous !== undefined ? { start: previous.end!, end: property.end!, text: '' } : { start: property.start!, end: next?.start ?? property.end! + lone, text: '' }

      found.push({ start: property.key.start!, end: property.end!, edit })
    }
  })

  return found
}

// A `// kay-allow` comment or a `lints` entry naming `identity-key`, which kay dropped in 1.69: the lint's runtime check went with the keyed matching of rows it warned of.
export async function retiredIdentityKey(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-identity-key', options.lints)

  if (level === 'allow')
    return []

  const name: string = RETIRED_LINTS[0]
  const found: CheckDiagnostic[] = []
  const report = (file: string, source: string, { start, end, edit }: { start: number, end: number, edit: Edit }, what: string) => found.push({
    file,
    ...positionAt(source, start),
    end,
    message: `${what} names \`${name}\`, a lint kay dropped: a \`for\` over objects with no \`id\` needs no key, and nothing warns of it`,
    help: `remove \`${name}\``,
    code: 'deprecated-identity-key',
    severity: level === 'warn' ? 'warning' : 'error',
    fixes: [{ title: `Remove ${name}`, edits: [edit], safe: true }],
  })

  for (const file of await findProjectFiles(root, KAY_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    for (const comment of allowComments(source, name))
      report(file, source, comment, 'This `// kay-allow`')
  }

  const config = join(root, CONFIG_FILE)
  let source: string | undefined

  try {
    source = readFileSync(config, 'utf8')
  }
  catch {}

  for (const entry of source === undefined ? [] : configEntries(source, name))
    report(config, source!, entry, '`lints`')

  return found
}

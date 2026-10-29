import type { ObjectExpression, PropertyKey } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import { findProjectFiles } from '../build/files'
import { elementsIn } from '../compiler/ast'
import { parseExpression } from '../compiler/estree'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { snakeCase } from '../server/snake-case'

const SOURCE_FILE = /\.(?:kay|[cm]?ts|tsx)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
const EXPORTED = /\bexport\s+(?:const|let|var|function|async\s+function)\s+([A-Za-z_$][\w$]*)/g
const QUOTED = /(['"`])([A-Z][\w-]*)\1/gi
// A name a second tool of the same name got: `add_note_2`.
const NUMBERED = /^(.+)_\d+$/

interface Labelled {
  file: string
  source: string
  keys: { name: string, at: number, end: number }[]
  // The source with the keys of the `toolLabels` blanked, which is where tool names are searched, so a key never vouches for itself.
  rest: string
}

// A key of a Chat's `toolLabels` that names no tool of the project: an action is a tool named by its export (`homeState` is `home_state`) or by its `tool.name`, and a function tool by its `name`, so a key matching none of them, nor any string the project writes, is a tool that was renamed or never was.
// Only a `toolLabels` written as an object literal is read, and only what the project's own modules write is searched.
export async function unknownToolLabels(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('unknown-tool-label', options.lints) === 'allow')
    return []

  const files = (await findProjectFiles(root, SOURCE_FILE, { project: true, ownKayOnly: true })).filter(file => !DECLARATION_FILE.test(file))
  const read = async (paths: string[]) => Promise.all(paths.map(async file => ({ file, source: await Bun.file(file).text() })))
  const written = await read(files.filter(file => file.endsWith('.kay')))
  const labelled = written.flatMap(({ file, source }) => source.includes('toolLabels') ? labelsIn(file, source) : [])

  if (labelled.length === 0)
    return []

  // The other modules are read once a `toolLabels` is found, as only they say which tools exist.
  const texts = [...written, ...await read(files.filter(file => !file.endsWith('.kay')))]
  const known = new Set<string>()
  const labelledFiles = new Map(labelled.map(item => [item.file, item.rest]))

  for (const { file, source } of texts) {
    const text = labelledFiles.get(file) ?? source

    for (const [, name] of text.matchAll(EXPORTED))
      known.add(snakeCase(name!))

    for (const [, , name] of text.matchAll(QUOTED))
      known.add(name!)
  }

  const found: CheckDiagnostic[] = []

  for (const { file, source, keys } of labelled) {
    const levelAt = lintLevels(source, options.lints)

    for (const key of keys) {
      const level = levelAt('unknown-tool-label', key.at)

      if (level === 'allow' || known.has(key.name) || known.has(NUMBERED.exec(key.name)?.[1] ?? ''))
        continue

      found.push({ file, ...positionAt(source, key.at), end: key.end, message: `\`toolLabels\` names \`${key.name}\`, which no tool of this project is called`, help: 'name the tool as the model calls it: its export in snake case (`homeState` is `home_state`), its `tool.name` or the `name` of its `tool()`; or drop the key and give the action `tool: { label }`', code: 'unknown-tool-label', severity: level === 'warn' ? 'warning' : 'error' })
    }
  }

  return found
}

function labelsIn(file: string, source: string): Labelled[] {
  const keys: Labelled['keys'] = []
  let rest = source

  for (const element of elementsIn(parseKay(source).template)) {
    for (const attribute of element.attributes) {
      if (attribute.kind !== 'expression' || source.slice(attribute.name.start, attribute.name.end) !== 'toolLabels')
        continue

      const expression = parseObject(source.slice(attribute.expression.start, attribute.expression.end))

      if (expression === undefined)
        continue

      rest = rest.slice(0, attribute.expression.start) + ' '.repeat(attribute.expression.end - attribute.expression.start) + rest.slice(attribute.expression.end)

      for (const property of expression.properties) {
        if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init')
          continue

        const name = keyName(property.key)

        if (name !== undefined)
          keys.push({ name, at: attribute.expression.start + property.key.start, end: attribute.expression.start + property.key.end })
      }
    }
  }

  return keys.length === 0 ? [] : [{ file, source, keys, rest }]
}

function parseObject(text: string): ObjectExpression | undefined {
  try {
    const expression = parseExpression(text)

    return expression.type === 'ObjectExpression' ? expression : undefined
  }
  catch {
    return undefined
  }
}

function keyName(key: PropertyKey): string | undefined {
  if (key.type === 'Identifier')
    return key.name

  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined
}

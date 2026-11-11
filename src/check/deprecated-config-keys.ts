import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import type { Bindings } from '../compiler/object-literal'
import { join } from 'node:path'
import { parseProgram } from '../compiler/estree'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { constBindings, exportedObject, keyName, objectOf, propertiesOf, unwrapped } from '../compiler/object-literal'
import { CONFIG_FILE } from '../config'
import { readConfigSource } from './config-keys'

const FONTS_PREFIX = /^fonts\./

type Property = NodeOfType<'Property'>
type ObjectNode = NodeOfType<'ObjectExpression'>

interface Rename {
  // The keys leading to the object holding the old key; `[]` is the config itself, and `fonts` is a list of objects.
  at: string[]
  from: string
  to: string
  // How the value moves with the key: kept, wrapped in a list when it is one literal, or turned into `{ max, window: '1m' }`.
  value: 'same' | 'list' | 'perMinute'
  // A key only an object holding this one carries, as `weight` of a Fontsource entry, which a font's own `weight` is not.
  with?: string
  since: string
}

// The config keys that changed name, read under the old one until 2.0.
export const RENAMED_KEYS: readonly Rename[] = [
  { at: ['serve'], from: 'apiPath', to: 'apiPrefix', value: 'same', since: '1.98' },
  { at: ['fonts'], from: 'subset', to: 'subsets', value: 'list', with: 'fontsource', since: '1.98' },
  { at: ['fonts'], from: 'weight', to: 'weights', value: 'list', with: 'fontsource', since: '1.98' },
  { at: ['live'], from: 'perMinute', to: 'rate', value: 'perMinute', since: '1.98' },
]

function named(properties: readonly Node[], name: string): Property | undefined {
  return properties.find((property): property is Property => property.type === 'Property' && keyName(property) === name)
}

// The objects a path names: through `fonts` the entries of a list, otherwise the object under each key.
function objectsAt(config: ObjectNode, path: string[], bindings: Bindings): ObjectNode[] {
  let found: ObjectNode[] = [config]

  for (const key of path) {
    found = found.flatMap((parent) => {
      const value = named(propertiesOf(parent, bindings), key)?.value

      if (!value)
        return []

      const inner = unwrapped(value)
      const list = inner.type === 'Identifier' ? bindings.get(inner.name) : inner

      if (list?.type === 'ArrayExpression')
        return list.elements.flatMap(element => (element?.type === 'ObjectExpression' ? [element] : []))

      const object = objectOf(value, bindings)

      return object ? [object] : []
    })
  }

  return found
}

// A config key under its name before 1.98: `serve.apiPath` is `serve.apiPrefix`, `subset` and `weight` of a Fontsource font `subsets` and `weights`, and `live.perMinute` is `live.rate` as `{ max, window }`.
// The key is renamed, a lone name or number written in a list, and `perMinute: 60` written as `rate: { max: 60, window: '1m' }`; a value that is not a literal, or an object that already holds the new key, is reported with no fix.
export function deprecatedConfigKeys(root: string, options: CheckOptions): CheckDiagnostic[] {
  if (lintLevel('deprecated-config-keys', options.lints) === 'allow')
    return []

  const source = readConfigSource(root)

  if (source === undefined || !RENAMED_KEYS.some(({ from }) => source.includes(from)))
    return []

  const { program } = parseProgram(source, { recover: true })
  const bindings = constBindings(program, true)
  const config = exportedObject(program, bindings)

  if (!config)
    return []

  const levelAt = lintLevels(source, options.lints)
  const found: CheckDiagnostic[] = []

  for (const rename of RENAMED_KEYS) {
    for (const object of objectsAt(config, rename.at, bindings)) {
      const properties = propertiesOf(object, bindings)
      const old = named(properties, rename.from)

      if (!old || (rename.with !== undefined && !named(properties, rename.with)) || levelAt('deprecated-config-keys', old.start) === 'allow')
        continue

      // Written in the object itself, not spread in from a const another object may share.
      const own = (object.properties as readonly Node[]).includes(old)
      const free = own && !old.computed && !old.shorthand && !named(properties, rename.to)
      const value = old.value
      const literal = value.type === 'Literal' && (typeof value.value === 'string' || typeof value.value === 'number')
      let edits: { start: number, end: number, text: string }[] | undefined

      if (free && rename.value === 'same')
        edits = [{ start: old.key.start, end: old.key.end, text: rename.to }]
      else if (free && rename.value === 'list' && (value.type === 'ArrayExpression' || literal))
        edits = value.type === 'ArrayExpression' ? [{ start: old.key.start, end: old.key.end, text: rename.to }] : [{ start: old.start, end: old.end, text: `${rename.to}: [${source.slice(value.start, value.end)}]` }]
      else if (free && rename.value === 'perMinute' && value.type === 'Literal' && typeof value.value === 'number')
        edits = [{ start: old.start, end: old.end, text: `rate: { max: ${source.slice(value.start, value.end)}, window: '1m' }` }]

      const path = [...rename.at, rename.from].join('.')
      const help = rename.value === 'perMinute' ? 'write `rate: { max, window }`, `perMinute: 120` being `rate: { max: 120, window: \'1m\' }`' : `write \`${rename.to}\``

      found.push({
        file: join(root, CONFIG_FILE),
        ...positionAt(source, old.start),
        end: old.end,
        message: `\`${path.replace(FONTS_PREFIX, '')}\` of kay.config.ts is deprecated since ${rename.since}: the key is \`${rename.to}\``,
        help,
        code: 'deprecated-config-keys',
        severity: levelAt('deprecated-config-keys', old.start) === 'warn' ? 'warning' : 'error',
        ...edits && { fixes: [{ title: help[0]!.toUpperCase() + help.slice(1), edits, safe: true }] },
      })
    }
  }

  return found.toSorted((a, b) => a.line - b.line || a.column - b.column)
}

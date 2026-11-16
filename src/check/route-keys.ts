import type { CheckDiagnostic, CheckOptions } from '.'
import type { NodeOfType } from '../compiler/estree'
import type { Property } from './regroup'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { configObjects, propertiesOf, propertyOf } from './config-objects'
import { nameOf } from './regroup'
import { scan } from './renamed-exports'

type ObjectExpression = NodeOfType<'ObjectExpression'>

const NEEDLE = /\b(?:apiPrefix|referencePath|openapi|mcp|health|metrics|jobs)\b/
const PUNCTUATION = /^[\s,]*$/
const BAGS = ['openapi', 'mcp', 'health', 'metrics', 'jobs'] as const
const OPS_BAGS = ['health', 'metrics', 'jobs']

// One old key: the bag holding it, its name, the property, and the `endpoints` key it is.
interface Old {
  bag: ObjectExpression
  from: string
  property: Property
  to: string
  // `openapi.referencePath`, which is `reference: { path }` and no key of `endpoints`.
  reference: boolean
}

// The edits that remove some properties of an object, or undefined where a comment would go with them: each takes its own span up to the next property, the last one that and the comma before it, and an object left empty is `{}`.
function removals(object: ObjectExpression, gone: ReadonlySet<Property>, text: string): Edit[] | undefined {
  const { properties } = object
  const edits: Edit[] = []

  if (properties.every(property => property.type === 'Property' && gone.has(property))) {
    const gaps = properties.map((property, index) => text.slice(index === 0 ? object.start + 1 : properties[index - 1]!.end, property.start)).concat(text.slice(properties.at(-1)!.end, object.end - 1))

    return gaps.every(gap => PUNCTUATION.test(gap)) ? [{ start: object.start, end: object.end, text: '{}' }] : undefined
  }

  for (const [index, property] of properties.entries()) {
    if (property.type !== 'Property' || !gone.has(property))
      continue

    const next = properties[index + 1]
    const previous = properties[index - 1]
    const alone = previous === undefined || (previous.type === 'Property' && gone.has(previous))
    const [start, end] = next === undefined ? [alone ? property.start : previous.end, property.end] : [property.start, next.start]
    const gap = next !== undefined ? text.slice(property.end, next.start) : text.slice(start, property.start)

    if (!PUNCTUATION.test(gap))
      return undefined

    edits.push({ start, end, text: '' })
  }

  return edits
}

// The keys that name where a feature is served, which are keys of `endpoints` since 1.105: `serve.apiPrefix` is `endpoints.api`, the `path` of `openapi`, `mcp`, `health`, `metrics` and `jobs` is `endpoints.openapi`, `.mcp`, `.health`, `.metrics` and `.jobs`, and `openapi.referencePath` is `openapi.reference: { path }`.
// The fix, from the first report of an object, writes the paths in a new `endpoints` and removes them where they were, and offers none where the object spreads, holds a computed key or an `endpoints` already, a bag is bound outside it, or a comment would be lost.
export async function routeKeys(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-route-keys', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-route-keys', NEEDLE, ({ file, parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      for (const { object, call } of configObjects(file, ast)) {
        // The options of a call are moved into `config` by `deprecated-pages-options` first.
        if (call !== undefined)
          continue

        const olds: Old[] = []
        const holders: Property[] = []
        const inline = (property: Property | undefined): ObjectExpression | undefined => property?.value.type === 'ObjectExpression' ? property.value : undefined
        const bagsOf = (owner: ObjectExpression, names: readonly string[], within?: Property): void => {
          for (const name of names) {
            for (const property of propertiesOf(owner, name)) {
              const bag = inline(property)

              for (const key of bag === undefined ? [] : propertiesOf(bag, 'path')) {
                holders.push(within ?? property)
                olds.push({ bag: bag!, from: name, property: key, to: name, reference: false })
              }

              for (const key of bag === undefined || name !== 'openapi' ? [] : propertiesOf(bag, 'referencePath'))
                olds.push({ bag: bag!, from: name, property: key, to: 'reference', reference: true })
            }
          }
        }

        bagsOf(object, BAGS)

        const opsProperty = propertyOf(object, 'ops')
        const ops = inline(opsProperty)

        if (ops !== undefined)
          bagsOf(ops, OPS_BAGS, opsProperty)

        for (const serve of propertiesOf(object, 'serve')) {
          const bag = inline(serve)

          for (const key of bag === undefined ? [] : propertiesOf(bag, 'apiPrefix')) {
            holders.push(serve)
            olds.push({ bag: bag!, from: 'serve', property: key, to: 'api', reference: false })
          }
        }

        if (olds.length === 0)
          continue

        const fix = fixOf(object, olds, holders, text, base)

        for (const [index, old] of olds.entries()) {
          report(base + old.property.start, base + old.property.end, old.reference ? '`openapi.referencePath` is `openapi.reference: { path }` since 1.105' : `\`${old.from}.${nameOf(old.property)}\` is \`endpoints.${old.to}\` since 1.105`, old.reference ? 'write `reference: { path }`' : `write the path in \`endpoints: { ${old.to} }\``, index === 0 ? fix : null)
        }
      }
    }
  })
}

function fixOf(object: ObjectExpression, olds: Old[], holders: Property[], text: string, base: number): Edit[] | null {
  if (object.properties.some(property => property.type !== 'Property' || property.computed) || propertiesOf(object, 'endpoints').length > 0)
    return null

  const edits: Edit[] = []
  const paths = new Map<string, string>()

  for (const old of olds) {
    if (old.property.kind !== 'init' || old.property.method || old.bag.properties.some(property => property.type !== 'Property' || property.computed))
      return null

    if (old.reference) {
      const reference = propertiesOf(old.bag, 'reference')[0]

      if (reference?.value.type !== 'Literal' || reference.value.value !== true)
        return null

      edits.push({ start: reference.value.start, end: reference.value.end, text: `{ path: ${text.slice(old.property.value.start, old.property.value.end)} }` })

      continue
    }

    if (paths.has(old.to))
      return null

    paths.set(old.to, text.slice(old.property.value.start, old.property.value.end))
  }

  for (const [bag, gone] of Map.groupBy(olds, old => old.bag)) {
    const removed = removals(bag, new Set(gone.map(old => old.property)), text)

    if (removed === undefined)
      return null

    edits.push(...removed)
  }

  if (paths.size > 0) {
    const first = holders.toSorted((a, b) => a.start - b.start)[0]!
    const lineStart = text.lastIndexOf('\n', first.start - 1) + 1
    const indent = text.slice(lineStart, first.start)
    const written = `endpoints: { ${[...paths].map(([name, value]) => `${name}: ${value}`).join(', ')} }`

    edits.push({ start: first.start, end: first.start, text: indent !== '' && PUNCTUATION.test(indent) ? `${written},\n${indent}` : `${written}, ` })
  }

  return edits.map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end }))
}

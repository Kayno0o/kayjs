import type { CheckDiagnostic, CheckOptions } from '.'
import type { Expression, NodeOfType } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { findProjectFiles } from '../build/files'
import { elementsIn } from '../compiler/ast'
import { parseExpression, parseProgram } from '../compiler/estree'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { constBindings, keyName, unwrapped } from '../compiler/object-literal'
import { parseKay } from '../compiler/parser'

interface ItemProp {
  // The prop holding the list, as `items`.
  prop: string
  // The old key of an item and its new one.
  renames: readonly (readonly [string, string])[]
}

// The kayjs-ui components whose item keys were renamed in 1.99, by component name.
const COMPONENTS: Record<string, ItemProp> = {
  Timeline: { prop: 'entries', renames: [['text', 'label']] },
  Accordion: { prop: 'items', renames: [['value', 'key'], ['title', 'label']] },
  MediaGallery: { prop: 'items', renames: [['title', 'label']] },
  AppSwitcher: { prop: 'apps', renames: [['id', 'key']] },
  AudioPlayer: { prop: 'chapters', renames: [['title', 'label'], ['url', 'href']] },
}

const NEEDLE = /\b(?:Timeline|Accordion|MediaGallery|AppSwitcher|AudioPlayer)\b/
const KAY_FILE = /\.kay$/

type Property = Extract<NodeOfType<'ObjectExpression'>['properties'][number], { type: 'Property' }>

// The item keys of a kayjs-ui Timeline, Accordion, MediaGallery, AppSwitcher or AudioPlayer an app writes under the name they had before 1.99, so every item is `{ key, label, description?, href?, icon?, tone?, disabled? }`.
// Found in a literal array given as the list, written there or bound to a `const` of the file's script; `{ text }` becomes `label: text`, and an item holding the new key already is reported with no fix.
export async function uiItems(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-ui-items', options.lints) === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, KAY_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!NEEDLE.test(source) || !source.includes('kayjs-ui'))
      continue

    const levelAt = lintLevels(source, options.lints)
    const parsed = parseKay(source)
    const bindings = parsed.script ? constBindings(parseProgram(source.slice(parsed.script.start, parsed.script.end), { lang: 'tsx', recover: true, offset: parsed.script.start }).program) : new Map<string, Expression>()
    const seen = new Set<number>()

    for (const element of elementsIn(parsed.template)) {
      const spec = element.component ? COMPONENTS[element.name] : undefined

      if (spec === undefined)
        continue

      for (const attribute of element.attributes) {
        if (attribute.kind !== 'expression' || source.slice(attribute.name.start, attribute.name.end) !== spec.prop)
          continue

        for (const item of itemsOf(source, attribute.expression, bindings)) {
          for (const [old, current] of spec.renames) {
            const property = item.properties.find((one): one is Property => one.type === 'Property' && keyName(one) === old)

            if (!property || seen.has(property.start))
              continue

            seen.add(property.start)

            const level = levelAt('deprecated-ui-items', property.start)

            if (level === 'allow')
              continue

            const taken = item.properties.some(one => one.type === 'Property' && keyName(one) === current)
            const edits: Edit[] | undefined = taken || property.computed ? undefined : [property.shorthand ? { start: property.start, end: property.end, text: `${current}: ${old}` } : { start: property.key.start, end: property.key.end, text: current }]

            found.push({
              file,
              ...positionAt(source, property.start),
              end: property.end,
              message: `\`${old}\` of a ${element.name} item is \`${current}\` since 1.99: an item of every kayjs-ui list is \`{ key, label, description, href, icon, tone, disabled }\`; \`${old}\` still works until it is removed`,
              help: `write \`${current}\``,
              code: 'deprecated-ui-items',
              severity: level === 'warn' ? 'warning' : 'error',
              ...edits && { fixes: [{ title: `Write \`${current}\``, edits, safe: true }] },
            })
          }
        }
      }
    }
  }

  return found
}

// The object literals of the array an attribute gives, which a name bound to a literal array in the script stands for.
function itemsOf(source: string, span: { start: number, end: number }, bindings: Map<string, Expression>): NodeOfType<'ObjectExpression'>[] {
  let list: Expression | undefined

  try {
    list = parseExpression(source.slice(span.start, span.end), { offset: span.start })
  }
  catch {
    return []
  }

  const inner = unwrapped(list)
  const array = inner.type === 'Identifier' ? bindings.get(inner.name) : inner
  const literal = array && unwrapped(array)

  if (literal?.type !== 'ArrayExpression')
    return []

  return literal.elements.flatMap((element) => {
    const item = element && unwrapped(element)

    return item?.type === 'ObjectExpression' ? [item] : []
  })
}

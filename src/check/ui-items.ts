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
  // The key of an item holding the items below it, as a tree's `children`: they are read too.
  nested?: string
}

// One deprecated lint over the items of kayjs-ui lists: the components it covers by the file they are imported from, and the minor that renamed their keys.
interface ItemLint {
  code: 'deprecated-ui-items' | 'deprecated-ui-item-keys'
  since: string
  components: Record<string, ItemProp>
}

// The kayjs-ui components whose item keys were renamed in 1.99, by the file they are imported from.
const ITEMS: ItemLint = {
  code: 'deprecated-ui-items',
  since: '1.99',
  components: {
    'timeline': { prop: 'entries', renames: [['text', 'label']] },
    'accordion': { prop: 'items', renames: [['value', 'key'], ['title', 'label']] },
    'media-gallery': { prop: 'items', renames: [['title', 'label']] },
    'app-switcher': { prop: 'apps', renames: [['id', 'key']] },
    'audio-player': { prop: 'chapters', renames: [['title', 'label'], ['url', 'href']] },
  },
}

// The ones renamed in 1.100: a tree's nodes and the notifications of a Bell.
const ITEM_KEYS: ItemLint = {
  code: 'deprecated-ui-item-keys',
  since: '1.100',
  components: {
    'tree-view': { prop: 'nodes', renames: [['id', 'key']], nested: 'children' },
    'bell': { prop: 'items', renames: [['id', 'key'], ['title', 'label'], ['url', 'href']] },
    'bell-inbox': { prop: 'items', renames: [['id', 'key'], ['title', 'label'], ['url', 'href']] },
  },
}

const LIBRARY_FILE = /^@kaynooo\/kayjs-ui\/([\w-]+)\.kay$/

const KAY_FILE = /\.kay$/

type Property = Extract<NodeOfType<'ObjectExpression'>['properties'][number], { type: 'Property' }>

// The item keys of a kayjs-ui Timeline, Accordion, MediaGallery, AppSwitcher or AudioPlayer an app writes under the name they had before 1.99, so every item is `{ key, label, description?, href?, icon?, tone?, disabled? }`.
// Found in a literal array given as the list, written there or bound to a `const` of the file's script; `{ text }` becomes `label: text`, and an item holding the new key already is reported with no fix.
export async function uiItems(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return itemLint(root, options, ITEMS)
}

// The same for a TreeView's nodes, nested `children` included, and a Bell's or BellInbox's notifications, under the names they had before 1.100.
export async function uiItemKeys(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return itemLint(root, options, ITEM_KEYS)
}

async function itemLint(root: string, options: CheckOptions, lint: ItemLint): Promise<CheckDiagnostic[]> {
  const { code, since, components } = lint

  if (lintLevel(code, options.lints) === 'allow')
    return []

  const needle = new RegExp(`kayjs-ui/(?:${Object.keys(components).join('|')})\\.kay`)

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, KAY_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!needle.test(source))
      continue

    const levelAt = lintLevels(source, options.lints)
    const parsed = parseKay(source)
    const program = parsed.script ? parseProgram(source.slice(parsed.script.start, parsed.script.end), { lang: 'tsx', recover: true, offset: parsed.script.start }).program : undefined
    const bindings = program ? constBindings(program) : new Map<string, Expression>()
    const bound = new Map<string, ItemProp>()

    // The names the file gives the components it imports from kayjs-ui, so a component of its own with the same name is left alone.
    for (const statement of program?.body ?? []) {
      if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type')
        continue

      const spec = LIBRARY_FILE.exec(statement.source.value) && components[LIBRARY_FILE.exec(statement.source.value)![1]!]

      for (const specifier of statement.specifiers) {
        if (spec && specifier.type === 'ImportDefaultSpecifier')
          bound.set(specifier.local.name, spec)
      }
    }
    const seen = new Set<number>()

    for (const element of elementsIn(parsed.template)) {
      const spec = element.component ? bound.get(element.name) : undefined

      if (spec === undefined)
        continue

      for (const attribute of element.attributes) {
        if (attribute.kind !== 'expression' || source.slice(attribute.name.start, attribute.name.end) !== spec.prop)
          continue

        for (const item of itemsOf(source, attribute.expression, bindings, spec.nested)) {
          for (const [old, current] of spec.renames) {
            const property = item.properties.find((one): one is Property => one.type === 'Property' && keyName(one) === old)

            if (!property || seen.has(property.start))
              continue

            seen.add(property.start)

            const level = levelAt(code, property.start)

            if (level === 'allow')
              continue

            const taken = item.properties.some(one => one.type === 'Property' && keyName(one) === current)
            const edits: Edit[] | undefined = taken || property.computed ? undefined : [property.shorthand ? { start: property.start, end: property.end, text: `${current}: ${old}` } : { start: property.key.start, end: property.key.end, text: current }]

            found.push({
              file,
              ...positionAt(source, property.start),
              end: property.end,
              message: `\`${old}\` of a ${element.name} item is \`${current}\` since ${since}: an item of every kayjs-ui list is \`{ key, label, description, href, icon, tone, disabled }\`; \`${old}\` still works until it is removed`,
              help: `write \`${current}\``,
              code,
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
function itemsOf(source: string, span: { start: number, end: number }, bindings: Map<string, Expression>, nested?: string): NodeOfType<'ObjectExpression'>[] {
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

  return literal?.type === 'ArrayExpression' ? objectsOf(literal, nested) : []
}

// The objects of an array literal, and when `nested` names a key, those of the array it holds in each, at any depth.
function objectsOf(array: NodeOfType<'ArrayExpression'>, nested: string | undefined): NodeOfType<'ObjectExpression'>[] {
  return array.elements.flatMap((element) => {
    const item = element && unwrapped(element)

    if (item?.type !== 'ObjectExpression')
      return []

    const below = nested === undefined ? undefined : item.properties.find((one): one is Property => one.type === 'Property' && keyName(one) === nested)?.value
    const children = below && unwrapped(below)

    return [item, ...children?.type === 'ArrayExpression' ? objectsOf(children, nested) : []]
  })
}

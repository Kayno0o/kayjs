import type { Expression, ObjectExpression, ObjectProperty } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import { findProjectFiles } from '../build/files'
import { parseProgram } from '../compiler/estree'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { keyName, unwrapped } from '../compiler/object-literal'
import { importsOf, walk } from './ast'

const SOURCE_FILE = /(?<!\.d)\.tsx?$/
const COLLECTION_FILE = /\bfrom\s+['"]kay\/content['"]/
const SLUG_PARAM = /[:*]slug/

function isPlain(property: ObjectExpression['properties'][number]): property is ObjectProperty {
  return property.type === 'Property' && property.kind === 'init' && !property.method && !property.computed
}

function propertyOf(object: ObjectExpression, name: string): ObjectProperty | undefined {
  return object.properties.find((property): property is ObjectProperty => isPlain(property) && keyName(property) === name)
}

function objectOf(node: Node | null | undefined): ObjectExpression | undefined {
  const found = node && unwrapped(node)

  return found?.type === 'ObjectExpression' ? found : undefined
}

// The object a feed's `item` function returns: its expression body, or the only `return` of its block.
function returnedObject(item: Expression): ObjectExpression | undefined {
  const fn = unwrapped(item)

  if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')
    return undefined

  if (fn.body?.type !== 'BlockStatement')
    return objectOf(fn.body)

  const returns: Node[] = []

  walk(fn.body, (node) => {
    if (node.type === 'ReturnStatement' && node.argument)
      returns.push(node.argument)
  })

  return returns.length === 1 ? objectOf(returns[0]) : undefined
}

// Whether a `path` is the route written with the entry's slug, `` `/blog/${post.slug}` `` for `/blog/:slug`, which the route gives the item by itself.
function isRoutePath(path: Expression, route: string): boolean {
  const value = unwrapped(path)

  if (value.type !== 'TemplateLiteral' || value.expressions.length !== 1)
    return false

  const slug = unwrapped(value.expressions[0]!)
  const [before, after] = route.split(SLUG_PARAM)

  return (slug.type === 'Identifier' ? slug.name === 'slug' : slug.type === 'MemberExpression' && !slug.computed && slug.property.type === 'Identifier' && slug.property.name === 'slug')
    && value.quasis[0]?.value.cooked === before && value.quasis[1]?.value.cooked === after
}

// The edit taking a property out of its object, with the comma that follows it or else the one before.
function dropProperty(object: ObjectExpression, property: ObjectProperty): { start: number, end: number, text: string } {
  const index = object.properties.indexOf(property)
  const next = object.properties[index + 1]

  if (next)
    return { start: property.start, end: next.start, text: '' }

  const before = object.properties[index - 1]

  return before ? { start: before.end, end: property.end, text: '' } : { start: property.start, end: property.end, text: '' }
}

// A collection with a `route` that still gives its entries' page a second way, which the route already is: a `url` function, and the `path` of the items of its feed. The route wins over `url`, so that is dropped; a `path` is dropped when it writes the route.
export async function deprecatedCollectionLinks(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-collection-links', options.lints) === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!COLLECTION_FILE.test(source) || !source.includes('route'))
      continue

    const { program: ast } = parseProgram(source, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts', recover: true })
    const { locals, namespaces } = importsOf(ast, from => from === 'kay/content', 'collection')
    const levelAt = lintLevels(source, options.lints)

    walk(ast, (node) => {
      if (node.type !== 'CallExpression')
        return

      const { callee } = node
      const calls = callee.type === 'Identifier' ? locals.has(callee.name) : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'collection'
      const object = calls ? objectOf(node.arguments[1]) : undefined
      const route = object && propertyOf(object, 'route')
      const routeValue = route && unwrapped(route.value)

      if (!object || routeValue?.type !== 'Literal' || typeof routeValue.value !== 'string')
        return

      const report = (start: number, end: number, message: string, help: string, edit: { start: number, end: number, text: string } | undefined) => {
        const level = levelAt('deprecated-collection-links', start)

        if (level === 'allow')
          return

        found.push({ file, ...positionAt(source, start), end, message, help, code: 'deprecated-collection-links', severity: level === 'warn' ? 'warning' : 'error', ...edit && { fixes: [{ title: 'Drop it', edits: [edit], safe: true }] } })
      }

      const url = propertyOf(object, 'url')
      const urlValue = url && unwrapped(url.value)

      if (url && (urlValue?.type === 'ArrowFunctionExpression' || urlValue?.type === 'FunctionExpression'))
        report(url.start, url.end, 'the collection has a `route`, which its entries\' pages follow whatever its `url` function says', 'drop `url`', dropProperty(object, url))

      const feed = propertyOf(object, 'feed')
      const feedObject = feed && objectOf(feed.value)
      const item = feedObject && propertyOf(feedObject, 'item')
      const returned = item && returnedObject(item.value)
      const path = returned && propertyOf(returned, 'path')

      if (path)
        report(path.start, path.end, 'the feed links its items to the collection\'s `route` by itself, so an item needs no `path`', 'drop the item\'s `path`', isRoutePath(path.value, routeValue.value) ? dropProperty(returned, path) : undefined)
    })
  }

  return found
}

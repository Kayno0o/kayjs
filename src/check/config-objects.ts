import type { Node, NodeOfType, Program } from '../compiler/estree'
import type { Property } from './regroup'
import { basename } from 'node:path'
import { constBindings, exportedObject, keyName, objectOf } from '../compiler/object-literal'
import { importedName, importsOf, walk } from './ast'
import { nameOf } from './regroup'

type ObjectExpression = NodeOfType<'ObjectExpression'>

// The options of `pages()` and `testSite()` that are no config key.
const PAGES_OPTIONS = ['root', 'dev', 'prebuilt', 'config']
const TEST_OPTIONS = [...PAGES_OPTIONS, 'outgoing', 'headers', 'use', 'locals', 'browser', 'islands', 'styles']

const FROM_SERVER = (source: string): boolean => source === 'kay/server' || source === 'kay'
const FROM_TEST = (source: string): boolean => source === 'kay/test'

// An object an app writes config keys in: the one kay.config.ts exports, or the options of a call of `pages()` or `testSite()` and the `config` they hold.
export interface ConfigObject {
  object: ObjectExpression
  // The options of a call, which hold keys that are no config.
  call?: 'pages' | 'testSite'
  // The keys of the object that are no config, for the options of a call.
  others: readonly string[]
}

export const isProperty = (property: Node): property is Property => property.type === 'Property'

// The property of an object under a name, written as a plain key.
export function propertyOf(object: ObjectExpression, name: string): Property | undefined {
  return object.properties.find((property): property is Property => isProperty(property) && !property.computed && !property.shorthand && nameOf(property) === name)
}

// The property of a feature in a config object, at its top level or, since 1.105, inside the group it belongs to (`images` in `assets`): every one found, as a file may hold the old form and the new.
export function featureProperties(object: ObjectExpression, bindings: ReturnType<typeof constBindings>, group: string, name: string): Property[] {
  const inGroup = propertyOf(object, group)
  const held = inGroup === undefined ? undefined : objectOf(inGroup.value, bindings)

  return [...propertiesOf(object, name).slice(0, 1), ...held === undefined ? [] : propertiesOf(held, name).slice(0, 1)]
}

// Whether a file names the `KayExtension` type, as one writing an extension does.
function namesExtension(ast: Program): boolean {
  return ast.body.some(statement => statement.type === 'ImportDeclaration' && statement.specifiers.some(specifier => specifier.type === 'ImportSpecifier' && importedName(specifier) === 'KayExtension'))
}

// The objects of a file that are written as config: kay.config.ts's export, the `config` of an extension a file typed `KayExtension` writes, and in any file the options handed to `pages()` or `testSite()` with the `config` object of each.
export function configObjects(file: string, ast: Program): ConfigObject[] {
  const bindings = constBindings(ast)
  const found: ConfigObject[] = []

  if (basename(file) === 'kay.config.ts') {
    const exported = exportedObject(ast, bindings)

    if (exported !== undefined)
      found.push({ object: exported, others: [] })
  }

  if (namesExtension(ast)) {
    walk(ast, (node) => {
      const config = node.type === 'ObjectExpression' && propertyOf(node, 'name') !== undefined ? propertyOf(node, 'config') : undefined
      const inner = config === undefined ? undefined : objectOf(config.value, bindings)

      if (inner !== undefined && inner === config?.value)
        found.push({ object: inner, others: [] })
    })
  }

  const calls = (['pages', 'testSite'] as const).map(name => ({ name, ...importsOf(ast, name === 'pages' ? FROM_SERVER : FROM_TEST, name) })).filter(call => call.locals.size > 0 || call.namespaces.size > 0)

  if (calls.length === 0)
    return found

  walk(ast, (node) => {
    if (node.type !== 'CallExpression')
      return

    const call = calls.find(one => node.callee.type === 'Identifier' ? one.locals.has(node.callee.name) : node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier' && one.namespaces.has(node.callee.object.name) && node.callee.property.type === 'Identifier' && node.callee.property.name === one.name)
    const options = call === undefined ? undefined : node.arguments[0]

    if (call === undefined || options?.type !== 'ObjectExpression')
      return

    found.push({ object: options, call: call.name, others: call.name === 'pages' ? PAGES_OPTIONS : TEST_OPTIONS })

    const config = propertyOf(options, 'config')
    const inner = config === undefined ? undefined : objectOf(config.value, bindings)

    if (inner !== undefined && inner === config?.value)
      found.push({ object: inner, others: [] })
  })

  return found
}

// The plain properties of an object written under a name, with the one a name of `keyName` reads.
export function propertiesOf(object: ObjectExpression, name: string): Property[] {
  return object.properties.filter((property): property is Property => isProperty(property) && !property.computed && keyName(property) === name)
}

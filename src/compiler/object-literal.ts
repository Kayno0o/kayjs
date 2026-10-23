// The one reader of an exported object literal that the config, the `ui` file and the message catalogs share: the object a module exports by default, through type wrappers, single-argument calls and top-level consts.
import type * as t from '@babel/types'

const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression'])

// The top-level `const` bindings of a module by name, which an identifier in the exported object may name.
export type Bindings = Map<string, t.Expression>

// `any` follows `let` and `var` bindings too, for the config files that read an object a plain `let` holds.
export function constBindings(program: t.Program, any = false): Bindings {
  const bindings: Bindings = new Map()

  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (declaration?.type !== 'VariableDeclaration' || (!any && declaration.kind !== 'const'))
      continue

    for (const declarator of declaration.declarations) {
      if (declarator.id.type === 'Identifier' && declarator.init)
        bindings.set(declarator.id.name, declarator.init)
    }
  }

  return bindings
}

// What `as`, `satisfies`, `!`, `<T>` and parentheses wrap.
export function unwrapped(node: t.Node): t.Node {
  let found = node

  while (WRAPPERS.has(found.type))
    found = (found as t.TSAsExpression).expression

  return found
}

// The node a module exports as its default: `export default <node>`, or `export { name as default }`, which answers the identifier.
export function exportedDefault(program: t.Program): t.Node | undefined {
  let exported: t.Node | undefined

  for (const statement of program.body) {
    if (statement.type === 'ExportDefaultDeclaration')
      exported = statement.declaration

    if (statement.type !== 'ExportNamedDeclaration' || statement.source)
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ExportSpecifier' && (specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value) === 'default')
        exported = specifier.local
    }
  }

  return exported
}

// The object literal `node` is or wraps, followed through top-level consts. With `calls`, a call handed one argument is transparent too (`defineMessages({ ... })`, `omit({ ... })`), which only the exported value is: inside it a call is a value, though a const bound to one is followed.
export function objectOf(node: t.Node | null | undefined, bindings: Bindings, calls = false, seen: ReadonlySet<string> = new Set()): t.ObjectExpression | undefined {
  const value = node && unwrapped(node)

  if (!value)
    return undefined

  if (value.type === 'ObjectExpression')
    return value

  if (calls && value.type === 'CallExpression' && value.arguments.length === 1)
    return objectOf(value.arguments[0], bindings, calls, seen)

  if (value.type === 'Identifier' && !seen.has(value.name))
    return objectOf(bindings.get(value.name), bindings, true, new Set([...seen, value.name]))

  return undefined
}

export function exportedObject(program: t.Program, bindings: Bindings = constBindings(program)): t.ObjectExpression | undefined {
  return objectOf(exportedDefault(program), bindings, true)
}

// The name a non-computed property is written under, as an identifier or a string.
export function keyName(property: t.ObjectProperty): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'StringLiteral' ? property.key.value : undefined
}

function nameOf(property: t.ObjectExpression['properties'][number]): string | undefined {
  return property.type === 'ObjectProperty' ? keyName(property) : undefined
}

// The properties of an object with the spread of a const object replaced by that object's own, in order, so a key written by `{ ...base }` reads as written in place. A spread that is not a const object stays as it is, and a key a later property writes again drops the earlier ones, as the object holds only the last.
export function propertiesOf(object: t.ObjectExpression, bindings: Bindings): t.ObjectExpression['properties'] {
  const flat = flattened(object, bindings, new Set())
  const last = new Map<string, t.ObjectExpression['properties'][number]>()

  for (const property of flat) {
    const name = nameOf(property)

    if (name !== undefined)
      last.set(name, property)
  }

  const kept = new Set<t.ObjectExpression['properties'][number]>()

  return flat.filter((property) => {
    if (kept.has(property))
      return false

    kept.add(property)

    const name = nameOf(property)

    return name === undefined || last.get(name) === property
  })
}

function flattened(object: t.ObjectExpression, bindings: Bindings, seen: ReadonlySet<string>): t.ObjectExpression['properties'] {
  return object.properties.flatMap((property) => {
    if (property.type !== 'SpreadElement')
      return [property]

    const name = unwrapped(property.argument)
    const spread = name.type === 'Identifier' && !seen.has(name.name) ? objectOf(name, bindings) : undefined

    return spread ? flattened(spread, bindings, new Set([...seen, (name as t.Identifier).name])) : [property]
  })
}

import type * as t from '@babel/types'
import { parse } from '@babel/parser'
import { constBindings, exportedDefault, objectOf, unwrapped } from '../compiler/object-literal'

export interface ConfigPosition {
  line: number
  column: number
}

const START: ConfigPosition = { line: 1, column: 1 }

function keyName(property: t.ObjectProperty): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'StringLiteral' ? property.key.value : undefined
}

function positionOf(node: t.Node): ConfigPosition {
  return node.loc ? { line: node.loc.start.line, column: node.loc.start.column + 1 } : START
}

// Where a key sits in kay.config.ts's source: the key itself when it is set, whatever its value, else the deepest key above it that is, else the `defineConfig` call or the default export. A source that cannot be read or has no such export puts everything at line 1.
export function configLocator(source: string | undefined): (path: string[]) => ConfigPosition {
  if (source === undefined)
    return () => START

  let ast: t.File

  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
  }
  catch {
    return () => START
  }

  const bindings = constBindings(ast.program)
  const exported = exportedDefault(ast.program)
  const root = exported && unwrapped(exported)

  if (!root)
    return () => START

  const anchor = positionOf(root)
  const config = objectOf(root, bindings, true)

  return (path) => {
    let found = anchor
    let object = config

    for (const key of path) {
      const property = object?.properties.find((candidate): candidate is t.ObjectProperty => candidate.type === 'ObjectProperty' && keyName(candidate) === key)

      if (!property)
        break

      found = positionOf(property.key)
      object = objectOf(property.value, bindings)
    }

    return found
  }
}

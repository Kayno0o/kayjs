import type * as t from '@babel/types'
import { parse } from '@babel/parser'

export interface ConfigPosition {
  line: number
  column: number
}

const START: ConfigPosition = { line: 1, column: 1 }

function bare(node: t.Node | null | undefined): t.Node | null | undefined {
  let current = node

  while (current && (current.type === 'TSAsExpression' || current.type === 'TSSatisfiesExpression' || current.type === 'ParenthesizedExpression' || current.type === 'TSNonNullExpression'))
    current = current.expression

  return current
}

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

function declarationsOf(statement: t.Statement): t.VariableDeclarator[] {
  if (statement.type === 'VariableDeclaration')
    return statement.declarations

  return statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration' ? statement.declaration.declarations : []
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

  const objects = new Map<string, t.ObjectExpression>()
  let exported: t.Node | null | undefined

  for (const statement of ast.program.body) {
    if (statement.type === 'ExportDefaultDeclaration')
      exported = statement.declaration

    for (const declaration of declarationsOf(statement)) {
      const init = bare(declaration.init)

      if (declaration.id.type === 'Identifier' && init?.type === 'ObjectExpression')
        objects.set(declaration.id.name, init)
    }
  }

  const root = bare(exported)

  if (!root)
    return () => START

  const anchor = positionOf(root)
  const objectOf = (node: t.Node | null | undefined): t.ObjectExpression | undefined => {
    const value = bare(node)

    if (value?.type === 'Identifier')
      return objects.get(value.name)

    return value?.type === 'ObjectExpression' ? value : undefined
  }
  const config = root.type === 'CallExpression' ? objectOf(root.arguments[0]) : objectOf(root)

  return (path) => {
    let found = anchor
    let object = config

    for (const key of path) {
      const property = object?.properties.find((candidate): candidate is t.ObjectProperty => candidate.type === 'ObjectProperty' && keyName(candidate) === key)

      if (!property)
        break

      found = positionOf(property.key)
      object = objectOf(property.value)
    }

    return found
  }
}

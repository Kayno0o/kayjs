import type * as t from '@babel/types'

// Calls `visit` on `node` and every node under it, comments and locations left out.
export function walk(node: t.Node, visit: (node: t.Node) => void): void {
  visit(node)

  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key.endsWith('Comments'))
      continue

    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string')
        walk(child as t.Node, visit)
    }
  }
}

// The name an import specifier takes from its module.
function importedName(specifier: t.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
}

// The local names `name` is imported as from the modules `from` accepts, and those of `import * as x` from them, type-only imports left out.
export function importsOf(ast: t.File, from: (source: string) => boolean, name: string): { locals: Set<string>, namespaces: Set<string> } {
  const locals = new Set<string>()
  const namespaces = new Set<string>()

  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || !from(statement.source.value))
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier')
        namespaces.add(specifier.local.name)
      else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && importedName(specifier) === name)
        locals.add(specifier.local.name)
    }
  }

  return { locals, namespaces }
}

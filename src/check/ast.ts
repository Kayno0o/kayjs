import type { ImportSpecifier } from 'oxc-parser'
import type { Node, Program } from '../compiler/estree'
import { VISITOR_KEYS } from '../compiler/estree'

// The nodes directly under `node`, in the order a traversal visits them.
export function childrenOf(node: Node): Node[] {
  const children: Node[] = []

  for (const key of VISITOR_KEYS[node.type] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[key]

    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string')
        children.push(child as Node)
    }
  }

  return children
}

// Calls `visit` on `node` and every node under it.
export function walk(node: Node, visit: (node: Node) => void): void {
  visit(node)

  for (const child of childrenOf(node))
    walk(child, visit)
}

// The name an import specifier takes from its module.
export function importedName(specifier: ImportSpecifier): string {
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
}

// The local names `name` is imported as from the modules `from` accepts, and those of `import * as x` from them, type-only imports left out.
export function importsOf(program: Program, from: (source: string) => boolean, name: string): { locals: Set<string>, namespaces: Set<string> } {
  const locals = new Set<string>()
  const namespaces = new Set<string>()

  for (const statement of program.body) {
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

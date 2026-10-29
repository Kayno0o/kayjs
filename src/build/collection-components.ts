import type { Node } from '../compiler/ast'
import type { Node as EstreeNode, Expression, NodeOfType, Program } from '../compiler/estree'
import { elementsIn } from '../compiler/ast'
import { parseProgram } from '../compiler/estree'
import { objectOf, unwrapped } from '../compiler/object-literal'
import { KAY_FILE } from './files'

// `Content`, or `post.Content`: an entry's body, rendering the components of its collection.
const CONTENT_TAG = /(?:^|\.)Content$/

interface Binding {
  source: string
  imported: string
}

// Whether a template renders a content entry's body.
export function rendersContent(template: readonly Node[]): boolean {
  for (const element of elementsIn(template)) {
    if (element.component && CONTENT_TAG.test(element.name))
      return true
  }

  return false
}

// The modules a page's server code imports, each with the names it takes from it, `*` for all of them.
export function importedNames(code: string): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>()

  for (const statement of parsed(code)?.body ?? []) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type')
      continue

    const taken = names.get(statement.source.value) ?? new Set()

    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier')
        taken.add(nameOf(specifier.imported))
      else
        taken.add(specifier.type === 'ImportDefaultSpecifier' ? 'default' : '*')
    }

    names.set(statement.source.value, taken)
  }

  return names
}

// The `.kay` components each collection a module exports hands its Markdown, as written: `collection(folder, { components: { Chart } })` with `Chart` imported from a `.kay` file.
// A collection kay cannot read that way, its components spread from elsewhere or built at run time, gives none.
export function collectionComponents(code: string): Map<string, string[]> {
  const body = parsed(code)?.body ?? []
  const bindings = new Map<string, Binding>()
  const declared = new Map<string, Expression>()
  const exported = new Map<string, string>()

  for (const statement of body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers)
        bindings.set(specifier.local.name, { source: statement.source.value, imported: importedName(specifier) })
    }

    if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === 'Identifier' && declarator.init) {
          declared.set(declarator.id.name, declarator.init)

          if (statement.type === 'ExportNamedDeclaration')
            exported.set(declarator.id.name, declarator.id.name)
        }
      }
    }

    if (statement.type === 'ExportNamedDeclaration' && !statement.source) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ExportSpecifier')
          exported.set(nameOf(specifier.exported), nameOf(specifier.local))
      }
    }

    if (statement.type === 'ExportDefaultDeclaration' && statement.declaration.type === 'Identifier')
      exported.set('default', statement.declaration.name)
  }

  const isCollection = (callee: EstreeNode) => {
    const binding = callee.type === 'Identifier' ? bindings.get(callee.name) : undefined

    return binding?.source === 'kay/content' && binding.imported === 'collection'
  }
  const components = new Map<string, string[]>()

  for (const [name, local] of exported) {
    const init = declared.get(local)
    const call = init && unwrapped(init)

    if (call?.type !== 'CallExpression' || !isCollection(call.callee))
      continue

    const property = objectOf(call.arguments[1], declared)?.properties.find(candidate => candidate.type === 'Property' && candidate.kind === 'init' && !candidate.method && !candidate.computed && keyOf(candidate.key) === 'components')
    const files = (objectOf(property?.type === 'Property' ? property.value : undefined, declared)?.properties ?? []).flatMap((entry) => {
      const value = entry.type === 'Property' && entry.kind === 'init' && !entry.method ? unwrapped(entry.value) : undefined
      const binding = value?.type === 'Identifier' ? bindings.get(value.name) : undefined

      return binding?.imported === 'default' && KAY_FILE.test(binding.source) ? [binding.source] : []
    })

    components.set(name, files)
  }

  return components
}

function parsed(code: string): Program | undefined {
  try {
    return parseProgram(code, { returnOutside: true, recover: true }).program
  }
  catch {
    return undefined
  }
}

function nameOf(node: EstreeNode): string {
  return node.type === 'Identifier' ? node.name : String((node as { value?: unknown }).value)
}

function importedName(specifier: NodeOfType<'ImportSpecifier' | 'ImportDefaultSpecifier' | 'ImportNamespaceSpecifier'>): string {
  if (specifier.type === 'ImportSpecifier')
    return nameOf(specifier.imported)

  return specifier.type === 'ImportDefaultSpecifier' ? 'default' : '*'
}

function keyOf(node: EstreeNode): string | undefined {
  if (node.type === 'Identifier')
    return node.name

  return node.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined
}

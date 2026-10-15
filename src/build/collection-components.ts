import type * as t from '@babel/types'
import type { Node } from '../compiler/ast'
import { parse } from '@babel/parser'
import { elementsIn } from '../compiler/ast'
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

  for (const statement of parsed(code)?.program.body ?? []) {
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
  const body = parsed(code)?.program.body ?? []
  const bindings = new Map<string, Binding>()
  const declared = new Map<string, t.Expression>()
  const exported = new Map<string, string>()

  for (const statement of body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers)
        bindings.set(specifier.local.name, { source: statement.source.value, imported: specifier.type === 'ImportSpecifier' ? nameOf(specifier.imported) : specifier.type === 'ImportDefaultSpecifier' ? 'default' : '*' })
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
          exported.set(nameOf(specifier.exported), specifier.local.name)
      }
    }

    if (statement.type === 'ExportDefaultDeclaration' && statement.declaration.type === 'Identifier')
      exported.set('default', statement.declaration.name)
  }

  const isCollection = (callee: t.Node) => {
    const binding = callee.type === 'Identifier' ? bindings.get(callee.name) : undefined

    return binding?.source === 'kay/content' && binding.imported === 'collection'
  }
  const object = (node: t.Node | undefined): t.ObjectExpression | undefined => {
    const value = node && unwrapped(node)

    return value?.type === 'ObjectExpression' ? value : value?.type === 'Identifier' ? object(declared.get(value.name)) : undefined
  }
  const components = new Map<string, string[]>()

  for (const [name, local] of exported) {
    const init = declared.get(local)
    const call = init && unwrapped(init)

    if (call?.type !== 'CallExpression' || !isCollection(call.callee))
      continue

    const property = object(call.arguments[1])?.properties.find((candidate): candidate is t.ObjectProperty => candidate.type === 'ObjectProperty' && !candidate.computed && keyOf(candidate.key) === 'components')
    const files = (object(property?.value)?.properties ?? []).flatMap((entry) => {
      const value = entry.type === 'ObjectProperty' ? unwrapped(entry.value) : undefined
      const binding = value?.type === 'Identifier' ? bindings.get(value.name) : undefined

      return binding?.imported === 'default' && KAY_FILE.test(binding.source) ? [binding.source] : []
    })

    components.set(name, files)
  }

  return components
}

function parsed(code: string): t.File | undefined {
  try {
    return parse(code, { sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, errorRecovery: true, plugins: ['typescript'] })
  }
  catch {
    return undefined
  }
}

function unwrapped(node: t.Node): t.Node {
  return node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression' || node.type === 'ParenthesizedExpression' ? unwrapped(node.expression) : node
}

function nameOf(node: t.Identifier | t.StringLiteral): string {
  return node.type === 'Identifier' ? node.name : node.value
}

function keyOf(node: t.Node): string | undefined {
  return node.type === 'Identifier' ? node.name : node.type === 'StringLiteral' ? node.value : undefined
}

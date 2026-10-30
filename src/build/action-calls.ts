import type { KayFile } from '../compiler/ast'
import type { Node, Program } from '../compiler/estree'

import { nodeExpressions, visitNodes } from '../compiler/ast'
import { parseProgram } from '../compiler/estree'
import { parseKay } from '../compiler/parser'
import { eachDescendant } from '../compiler/walk'

// Worth parsing a source for at all.
const MENTIONED = /\baction\b|export\s*\*/

// Whether `node`, met under `parent`, names a binding rather than reading one: a declaration's name, a member's property, a key written before its colon.
function isName(node: Node, parent: Node): boolean {
  if (parent.type === 'MemberExpression')
    return parent.property === node && !parent.computed

  if (parent.type === 'Property')
    return parent.key === node && !parent.computed && !parent.shorthand

  if (parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition')
    return parent.key === node && !parent.computed

  if (parent.type === 'VariableDeclarator' || parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression')
    return parent.id === node

  return parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier'
}

// Whether a node creates or hands on kay's `action`: a call of it, with or without type arguments, a read of it as a value, an import of it under another name, or a re-export of it.
// A member `.action` of a namespace import of kay reads it too; any other member does not, as `event.action` is not kay's.
function isActionUse(node: Node, parent: Node | undefined, namespaces: ReadonlySet<string>): boolean {
  if (node.type === 'Identifier')
    return node.name === 'action' && parent !== undefined && !isName(node, parent)

  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'action')
    return node.object.type === 'Identifier' && namespaces.has(node.object.name)

  if (node.type === 'CallExpression') {
    const { callee } = node

    if (callee.type === 'Identifier')
      return callee.name === 'action'

    return callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'action'
  }

  if (node.type === 'ImportSpecifier')
    return node.imported.type === 'Identifier' ? node.imported.name === 'action' && node.local.name !== 'action' : node.imported.value === 'action'

  if (node.type === 'ExportSpecifier')
    return node.local.type === 'Identifier' ? node.local.name === 'action' : node.local.value === 'action'

  return node.type === 'ExportAllDeclaration' && node.source.value === 'kay'
}

// The names a `import * as name from 'kay'` gives kay's namespace.
function namespacesOf(program: Program): Set<string> {
  const names = new Set<string>()

  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration' && statement.source.value === 'kay') {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier')
          names.add(specifier.local.name)
      }
    }
  }

  return names
}

function parse(code: string): Program {
  return parseProgram(code, { lang: 'tsx', recover: true, returnOutside: true }).program
}

function usesAction(program: Program, namespaces: ReadonlySet<string>): boolean {
  let found = false

  for (const statement of program.body) {
    if (isActionUse(statement, undefined, namespaces))
      return true

    eachDescendant(statement, (node, parent) => {
      found ||= isActionUse(node, parent, namespaces)
    })

    if (found)
      return true
  }

  return false
}

// Whether a `{...}` of the template, an attribute value or the head of a block uses `action`; text and tag names are not code. A slot's or a snippet's parameters are not an expression.
function templateUsesAction(file: KayFile, source: string): boolean {
  const namespaces = new Set([file.script, file.server, file.module].flatMap(span => span === undefined ? [] : [...namespacesOf(parse(source.slice(span.start, span.end)))]))
  let found = false

  visitNodes(file.template, (node) => {
    if (found || node.kind === 'slot' || node.kind === 'snippet')
      return

    found = nodeExpressions(node).some((span) => {
      const text = source.slice(span.start, span.end)

      return MENTIONED.test(text) && usesAction(parse(`(${text}\n)`), namespaces)
    })
  })

  return found
}

// Whether a `.kay` file or a script of the app, read as text, calls `action`, reads it as a value, imports it under another name or re-exports it; a comment or a string holding `action(` does not count.
export function declaresAction(source: string, kay: boolean): boolean {
  if (!MENTIONED.test(source))
    return false

  try {
    if (!kay) {
      const program = parse(source)

      return usesAction(program, namespacesOf(program))
    }

    const file = parseKay(source)

    if ([file.script, file.server, file.module].some((span) => {
      if (span === undefined)
        return false

      const program = parse(source.slice(span.start, span.end))

      return usesAction(program, namespacesOf(program))
    })) {
      return true
    }

    return templateUsesAction(file, source)
  }
  catch {
    // A source that cannot be read keeps the reviver.
    return true
  }
}

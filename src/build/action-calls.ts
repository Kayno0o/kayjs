import type { KayFile } from '../compiler/ast'
import type { Node, Program } from '../compiler/estree'

import { nodeExpressions, visitNodes } from '../compiler/ast'
import { parseProgram } from '../compiler/estree'
import { parseExpanded } from '../compiler/markdown-block'
import { eachDescendant } from '../compiler/walk'

// Worth parsing a source for at all.
const MENTIONED = /\baction\b|export\s*\*/

// Whether `node`, met under `parent`, names a binding rather than reading one: a declaration's name, a member's property, a key written before its colon.
function isName(node: Node, parent: Node): boolean {
  if (parent.type === 'MemberExpression')
    return parent.property === node && !parent.computed

  if (parent.type === 'Property')
    return parent.key === node && !parent.computed && !parent.shorthand

  if (parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition' || parent.type === 'TSPropertySignature' || parent.type === 'TSMethodSignature')
    return parent.key === node && !parent.computed

  if (parent.type === 'TSEnumMember')
    return parent.id === node

  if (parent.type === 'VariableDeclarator' || parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression')
    return parent.id === node

  return parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier'
}

// The expression under a cast, a non-null assertion, a chain or parentheses.
function unwrap(node: Node): Node {
  let current = node

  while (current.type === 'TSNonNullExpression' || current.type === 'TSAsExpression' || current.type === 'TSSatisfiesExpression' || current.type === 'TSTypeAssertion' || current.type === 'ChainExpression' || current.type === 'ParenthesizedExpression')
    current = current.expression

  return current
}

// Whether a node creates or hands on kay's `action`: a call of it, with or without type arguments, a read of it as a value, an import of it under another name, or a re-export of it.
// A member `.action` of a namespace import of kay reads it too; any other member does not, as `event.action` is not kay's.
function isActionUse(node: Node, parent: Node | undefined, namespaces: ReadonlySet<string>): boolean {
  if (node.type === 'Identifier')
    return node.name === 'action' && parent !== undefined && !isName(node, parent)

  // A pattern reading `action` out of kay's namespace: `const { action: act } = kay`.
  if (node.type === 'ObjectPattern')
    return node.properties.some(property => property.type === 'Property' && !property.computed && (property.key.type === 'Identifier' ? property.key.name === 'action' : property.key.type === 'Literal' && property.key.value === 'action'))

  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'action') {
    const object = unwrap(node.object)

    return object.type === 'Identifier' && namespaces.has(object.name)
  }

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

// The names holding kay's namespace: `import * as name from 'kay'` and `const name = await import('kay')`.
function namespacesOf(program: Program, names = new Set<string>()): Set<string> {
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration' && statement.source.value === 'kay') {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier')
          names.add(specifier.local.name)
      }
    }

    if (statement.type === 'VariableDeclaration') {
      for (const { id, init } of statement.declarations) {
        const value = init ? unwrap(init.type === 'AwaitExpression' ? init.argument : init) : undefined

        if (id.type === 'Identifier' && value?.type === 'ImportExpression' && value.source.type === 'Literal' && value.source.value === 'kay')
          names.add(id.name)
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

// Whether a `{...}` of the template, an attribute value or the head of a block uses `action`; text and tag names are not code. Parameters are read as an arrow function's, for their defaults.
function templateUsesAction(file: KayFile, namespaces: ReadonlySet<string>): boolean {
  const { source } = file
  let found = false

  visitNodes(file.template, (node) => {
    if (found)
      return

    const params = node.kind === 'slot' || node.kind === 'snippet' ? node.params : undefined

    found = nodeExpressions(node).some((span) => {
      const text = source.slice(span.start, span.end)

      return MENTIONED.test(text) && usesAction(parse(span === params ? `((${text}\n) => 0)` : `(${text}\n)`), namespaces)
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

    // A `markdown` block is lowered to template lines first, so its `{...}` are read like any other.
    const { file } = parseExpanded(source)
    const programs = [file.script, file.server, file.module].flatMap(span => span === undefined ? [] : [parse(file.source.slice(span.start, span.end))])
    const namespaces = new Set<string>()

    for (const program of programs)
      namespacesOf(program, namespaces)

    return programs.some(program => usesAction(program, namespaces)) || templateUsesAction(file, namespaces)
  }
  catch {
    // A source that cannot be read keeps the reviver.
    return true
  }
}

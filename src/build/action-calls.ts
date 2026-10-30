import type { Node } from '../compiler/estree'
import { parseProgram } from '../compiler/estree'
import { parseKay } from '../compiler/parser'
import { eachDescendant } from '../compiler/walk'

// Worth parsing a source for at all.
const MENTIONED = /\baction\b|export\s*\*/

// Whether a node creates or hands on kay's `action`: a call of it, with or without type arguments, an import of it under another name, or a re-export of it.
function isActionUse(node: Node): boolean {
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

function usesAction(code: string): boolean {
  const { program } = parseProgram(code, { lang: 'tsx', recover: true, returnOutside: true })

  let found = false

  for (const statement of program.body) {
    if (isActionUse(statement))
      return true

    eachDescendant(statement, (node) => {
      found ||= isActionUse(node)
    })

    if (found)
      return true
  }

  return false
}

// Whether a `.kay` file or a script of the app, read as text, calls `action`, imports it under another name or re-exports it; a comment or a string holding `action(` does not count.
export function declaresAction(source: string, kay: boolean): boolean {
  if (!MENTIONED.test(source))
    return false

  try {
    if (!kay)
      return usesAction(source)

    const file = parseKay(source)

    return [file.script, file.server, file.module].some(span => span !== undefined && usesAction(source.slice(span.start, span.end)))
  }
  catch {
    // A source that cannot be read keeps the reviver.
    return true
  }
}

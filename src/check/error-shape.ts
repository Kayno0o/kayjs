import type { CallExpression, ImportDeclaration, ImportSpecifier } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, Program } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { childrenOf, importedName } from './ast'
import { mentions, scan } from './renamed-exports'
import { dropSpecifier } from './safe-redirect'

const ANSWER = /\.answer\b/
const REFUSAL_MESSAGE = /\brefusalMessage\b/
const ERROR_CLASSES = new Set(['ApiError', 'ActionError'])
const SCOPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
// Where a conditional reads without parentheses around it.
const BARE_PARENTS = new Set(['VariableDeclarator', 'AssignmentExpression', 'ReturnStatement', 'ExpressionStatement', 'ArrowFunctionExpression', 'CallExpression', 'TemplateLiteral', 'Property'])

// The local names the project's ApiError and ActionError go by, from the imports of `kay`, types included.
function errorClasses(ast: Program, kay: boolean): Set<string> {
  const names = new Set<string>()

  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay')
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && ERROR_CLASSES.has(importedName(specifier)))
        names.add(specifier.local.name)
    }
  }

  // A `.kay` fence reads every kay export without an import.
  return names.size === 0 && kay ? new Set(ERROR_CLASSES) : names
}

// What a scope tells of its names, nested functions left out: the ones an `instanceof` of an error class narrows and the ones a `catch` binds.
function narrowed(scope: Node, classes: Set<string>): { checked: Set<string>, caught: Set<string> } {
  const checked = new Set<string>()
  const caught = new Set<string>()
  const visit = (node: Node) => {
    if (node.type === 'BinaryExpression' && node.operator === 'instanceof' && node.left.type === 'Identifier' && node.right.type === 'Identifier' && classes.has(node.right.name))
      checked.add(node.left.name)

    if (node.type === 'CatchClause' && node.param?.type === 'Identifier')
      caught.add(node.param.name)

    for (const child of childrenOf(node)) {
      if (!SCOPES.has(child.type))
        visit(child)
    }
  }

  for (const child of childrenOf(scope))
    visit(child)

  return { checked, caught }
}

// `.answer` of an `ApiError`, `data` since 1.87: the fix is safe where an `instanceof` of `ApiError` or `ActionError` narrows the receiver in the same function, and a receiver only a `catch` or a cast says is an error is reported with no fix. Any other `.answer` is none of this lint's.
export async function apiErrorAnswers(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-api-error-answer', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-api-error-answer', ANSWER, ({ file, parsed, report }) => {
    for (const { ast, base } of parsed) {
      const classes = errorClasses(ast, file.endsWith('.kay'))

      if (classes.size === 0)
        continue

      const visit = (node: Node, scope: Node, facts: ReturnType<typeof narrowed>) => {
        if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'answer') {
          const receiver = node.object
          const known = receiver.type === 'Identifier' && facts.checked.has(receiver.name)
          const cast = receiver.type === 'TSAsExpression' && receiver.typeAnnotation.type === 'TSTypeReference' && receiver.typeAnnotation.typeName.type === 'Identifier' && classes.has(receiver.typeAnnotation.typeName.name)

          if (known || cast || (receiver.type === 'Identifier' && facts.caught.has(receiver.name)))
            report(base + node.property.start, base + node.property.end, '`answer` is `data` on an `ApiError` since 1.87, and the old name works until 1.90', 'read `data`', known ? [{ start: base + node.property.start, end: base + node.property.end, text: 'data' }] : null)
        }

        for (const child of childrenOf(node)) {
          if (SCOPES.has(child.type))
            visit(child, child, narrowed(child, classes))
          else
            visit(child, scope, facts)
        }
      }

      visit(ast, ast, narrowed(ast, classes))
    }
  })
}

// `refusalMessage(error, fallback)`, deprecated since 1.87 for the `message` every `ApiError` carries: the fix, offered but never applied by `kay upgrade`, as an `ActionError` now also gives its field messages and `data.message` where `refusalMessage` gave the fallback.
export async function refusalMessages(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-refusal-message', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-refusal-message', REFUSAL_MESSAGE, ({ file, parsed, unparsed, report }) => {
    for (const { ast, base, text } of parsed) {
      const imports = ast.body.filter((statement): statement is ImportDeclaration => statement.type === 'ImportDeclaration' && statement.importKind !== 'type' && statement.source.value === 'kay')
      const declaration = imports.find(statement => statement.specifiers.some(one => one.type === 'ImportSpecifier' && importedName(one) === 'refusalMessage'))
      const specifier = declaration?.specifiers.find((one): one is ImportSpecifier => one.type === 'ImportSpecifier' && importedName(one) === 'refusalMessage')
      const local = specifier?.local.name ?? (file.endsWith('.kay') ? 'refusalMessage' : undefined)

      if (local === undefined)
        continue

      const present = imports.flatMap(statement => statement.specifiers).find((one): one is ImportSpecifier => one.type === 'ImportSpecifier' && importedName(one) === 'ApiError')
      const calls: { call: CallExpression, parent: Node }[] = []
      let reads = 0

      const visit = (node: Node, parent: Node) => {
        if (node.type === 'ImportDeclaration')
          return

        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === local && node.arguments.length === 2 && node.arguments.every(argument => argument.type !== 'SpreadElement'))
          calls.push({ call: node, parent })

        if (node.type === 'Identifier' && node.name === local)
          reads++

        for (const child of childrenOf(node))
          visit(child, node)
      }

      for (const statement of ast.body)
        visit(statement, ast)

      // Each call reads the name once as its callee; any other read is the function used as a value.
      const rewritable = reads === calls.length && !REFUSAL_MESSAGE.test(unparsed) && !(present === undefined && specifier !== undefined && mentions([ast], 'ApiError'))
      const name = present?.local.name ?? 'ApiError'
      const importEdits: Edit[] = []

      if (rewritable && declaration && specifier)
        importEdits.push(present ? dropSpecifier(declaration, specifier, text) : { start: specifier.start, end: specifier.end, text: 'ApiError' })

      for (const [index, { call, parent }] of calls.entries()) {
        const [error, fallback] = call.arguments as [Node, Node]
        const edits: Edit[] | null = !rewritable || error.type !== 'Identifier' ? null : [{ start: call.start, end: call.end, text: replacement(error.name, name, text.slice(fallback.start, fallback.end), BARE_PARENTS.has(parent.type)) }, ...index === 0 ? importEdits : []].map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end }))

        const shown = error.type === 'Identifier' ? error.name : 'error'

        report(base + call.callee.start, base + call.callee.end, '`refusalMessage` is deprecated since 1.87: an `ApiError`\'s `message` is always safe to show, and the old name works until 1.90', `write \`${shown} instanceof ApiError && ${shown}.status !== 0 ? ${shown}.message : fallback\``, edits, false)
      }
    }
  })
}

function replacement(error: string, errorClass: string, fallback: string, bare: boolean): string {
  const text = `${error} instanceof ${errorClass} && ${error}.status !== 0 ? ${error}.message : ${fallback}`

  return bare ? text : `(${text})`
}

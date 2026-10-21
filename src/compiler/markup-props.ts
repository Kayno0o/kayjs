// The `deprecated-markup-prop` lint: a prop typed `JSX.Element`, or a function returning it, is a `Snippet` since 1.70.

import type * as t from '@babel/types'
import type { Diagnostic, Fix } from './ast'
import type { ParsedFence } from './script'
import { eachNode } from './each-node'

interface Rewrite {
  node: t.Node
  text: string | undefined
}

const SNIPPET = 'Snippet'

// A markup prop in the props type of the fence, or in an interface or alias of it the props type names, with one fix rewriting them all and the import: each diagnostic carries the same fix, applied once.
export function markupProps(fence: ParsedFence, source: string): Diagnostic[] {
  if (!fence.code.includes('JSX'))
    return []

  const body = fence.ast.program.body
  const imported = body.flatMap(statement => statement.type === 'ImportDeclaration' && statement.source.value === 'kay' ? statement.specifiers.flatMap(specifier => specifier.type === 'ImportSpecifier' && importedName(specifier) === 'JSX' ? [{ statement, specifier }] : []) : [])
  const namespace = imported[0]

  if (!namespace)
    return []

  const jsx = namespace.specifier.local.name
  const declarations = new Map<string, t.Node>()

  for (const statement of body) {
    const declaration = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement

    if (declaration.type === 'TSInterfaceDeclaration')
      declarations.set(declaration.id.name, declaration.body)
    else if (declaration.type === 'TSTypeAliasDeclaration')
      declarations.set(declaration.id.name, declaration.typeAnnotation)
  }

  const roots: t.Node[] = []
  const seen = new Set<string>()
  const reach = (root: t.Node) => {
    roots.push(root)
    eachNode(root, (node) => {
      if (node.type !== 'TSTypeReference' || node.typeName.type !== 'Identifier' || seen.has(node.typeName.name))
        return

      const named = declarations.get(node.typeName.name)

      if (named) {
        seen.add(node.typeName.name)
        reach(named)
      }
    })
  }

  eachNode(fence.ast.program, (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'props' && node.typeParameters?.params[0])
      reach(node.typeParameters.params[0])
  })

  const found: Rewrite[] = []

  for (const root of roots) {
    eachNode(root, (node) => {
      if (node.type !== 'TSPropertySignature' || !node.typeAnnotation)
        return

      const rewrites = rewritesOf(node.typeAnnotation.typeAnnotation, jsx, fence.code)

      if (rewrites.length === 0)
        return

      found.push(...rewrites)

      // What a rewrite keeps of its parameters' types is read again by the next run.
      return false
    })
  }

  if (found.length === 0)
    return []

  const fix = fixOf(fence, source, found, namespace, jsx)

  return found.map(({ node }) => ({
    ...fence.shift(node),
    code: 'deprecated-markup-prop',
    message: 'A markup prop is typed `Snippet` since 1.70, not `JSX.Element` or a function returning it',
    note: '`Snippet` names the children, a block and the markup a component calls with values alike, and takes no `JSX` import',
    help: 'write `Snippet`, or `Snippet<[Item, number]>` for markup called with an item and its index',
    fixes: fix ? [fix] : [],
    checkOnly: true,
  }))
}

function importedName(specifier: t.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
}

function isElement(type: t.TSType | undefined, jsx: string): boolean {
  return type?.type === 'TSTypeReference' && type.typeName.type === 'TSQualifiedName' && type.typeName.left.type === 'Identifier' && type.typeName.left.name === jsx && type.typeName.right.name === 'Element' && !type.typeParameters
}

// What turns a prop's type into a `Snippet`: the type itself, a function returning markup, or such a member of a union with `undefined`. A `JSX.Element[]` is a list of values, not a snippet.
function rewritesOf(type: t.TSType, jsx: string, code: string): Rewrite[] {
  if (isElement(type, jsx))
    return [{ node: type, text: SNIPPET }]

  if (type.type === 'TSFunctionType') {
    return !isElement(type.typeAnnotation?.typeAnnotation, jsx) ? [] : [{ node: type, text: argumentsOf(type, code) }]
  }

  if (type.type === 'TSUnionType')
    return type.types.flatMap(member => rewritesOf(member, jsx, code))

  if (type.type === 'TSParenthesizedType') {
    const [inner] = rewritesOf(type.typeAnnotation, jsx, code)

    return inner && inner.node === type.typeAnnotation ? [{ node: type, text: inner.text }] : rewritesOf(type.typeAnnotation, jsx, code)
  }

  return []
}

// `Snippet<[item: T, index: number]>`; none of it when a parameter or the function itself is something a tuple cannot spell.
function argumentsOf(type: t.TSFunctionType, code: string): string | undefined {
  if (type.typeParameters)
    return undefined

  const params = type.parameters

  if (params.length === 0)
    return SNIPPET

  const labelled = params.every(param => param.type === 'Identifier' || (param.type === 'RestElement' && param.argument.type === 'Identifier'))
  const elements: string[] = []

  for (const param of params) {
    const annotation = param.typeAnnotation?.type === 'TSTypeAnnotation' ? param.typeAnnotation.typeAnnotation : undefined

    if (!annotation)
      return undefined

    const written = code.slice(annotation.start!, annotation.end!)

    if (param.type === 'RestElement')
      elements.push(labelled ? `...${(param.argument as t.Identifier).name}: ${written}` : `...${written}`)
    else if (param.type === 'Identifier')
      elements.push(labelled ? `${param.name}${param.optional ? '?' : ''}: ${written}` : `${written}${param.optional ? '?' : ''}`)
    else if (param.type === 'ObjectPattern' || param.type === 'ArrayPattern')
      elements.push(`${written}${param.optional ? '?' : ''}`)
    else
      return undefined
  }

  return `${SNIPPET}<[${elements.join(', ')}]>`
}

function fixOf(fence: ParsedFence, source: string, found: Rewrite[], namespace: { statement: t.ImportDeclaration, specifier: t.ImportSpecifier }, jsx: string): Fix | undefined {
  if (found.some(({ text }) => text === undefined))
    return undefined

  const { statement, specifier } = namespace
  const kept = statement.specifiers.filter(other => other !== specifier)
  const alreadyThere = statement.specifiers.some(other => other.type === 'ImportSpecifier' && importedName(other) === SNIPPET)

  // Another name `Snippet` in the file would be shadowed by the import.
  if (!alreadyThere && new RegExp(`\\b${SNIPPET}\\b`).test(fence.code))
    return undefined

  const edits = found.map(({ node, text }) => ({ ...fence.shift(node), text: text! }))
  const masked = [...edits, fence.shift(statement)].reduce((text, { start, end }) => text.slice(0, start) + ' '.repeat(end - start) + text.slice(end), source)
  const stillUsed = new RegExp(`\\b${jsx.replace('$', '\\$')}\\b`).test(masked)
  const at = fence.shift(specifier)

  if (stillUsed && !alreadyThere)
    edits.push({ start: at.end, end: at.end, text: `, ${statement.importKind !== 'type' && specifier.importKind === 'type' ? 'type ' : ''}${SNIPPET}` })
  else if (!stillUsed && !alreadyThere)
    edits.push({ ...at, text: `${statement.importKind !== 'type' && specifier.importKind === 'type' ? 'type ' : ''}${SNIPPET}` })
  else if (!stillUsed && kept.length === 0)
    edits.push({ ...fence.shift(statement), ...removal(source, fence.shift(statement)) })
  else if (!stillUsed)
    edits.push(removeSpecifier(statement, specifier, fence))

  return { title: 'Write `Snippet`', edits, safe: true }
}

// The statement and the line break after it.
function removal(source: string, span: { start: number, end: number }): { start: number, end: number, text: string } {
  return { start: span.start, end: source[span.end] === '\n' ? span.end + 1 : span.end, text: '' }
}

// A specifier with the comma beside it.
function removeSpecifier(statement: t.ImportDeclaration, specifier: t.ImportSpecifier, fence: ParsedFence): { start: number, end: number, text: string } {
  const span = fence.shift(specifier)
  const index = statement.specifiers.indexOf(specifier)
  const next = statement.specifiers[index + 1]

  if (next)
    return { start: span.start, end: fence.shift(next).start, text: '' }

  const before = fence.shift(statement.specifiers[index - 1]!)

  return { start: before.end, end: span.end, text: '' }
}

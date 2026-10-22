import type * as t from '@babel/types'
import type { Attribute, KayFile, Node, Span } from './ast'
import { parseExpression } from '@babel/parser'
import { childBlocks, nodeExpressions, visitNodes } from './ast'
import { codeOf, KAY_NAME } from './script'

const WORD = /[\w$]+/g
const FIRST_NAME = /^\s*([\w$]+)/

// The spans of a node that declare names for its children, which its expressions do not read.
function binders(node: Node): Span[] {
  switch (node.kind) {
    case 'for':
      return node.index ? [node.item, node.index] : [node.item]
    case 'const':
      return [node.pattern]
    case 'snippet':
      return [node.name, node.params]
    case 'slot':
      return node.params ? [node.params] : []
    case 'if':
      return node.branches.flatMap(branch => branch.alias ? [branch.alias] : [])
    case 'await':
      return [node.resolved?.alias, node.rejected?.alias].filter(alias => alias !== undefined)
    case 'try':
      return node.rejected?.alias ? [node.rejected.alias] : []
    case 'element':
    case 'error':
    case 'match':
    case 'pending':
    case 'text':
      return []
  }
}

// Every name a function inside the expression takes as a parameter, which shadows a value of kay there; none when the expression does not parse.
function parameters(code: string): Set<string> | undefined {
  const names = new Set<string>()
  let expression: t.Expression

  try {
    expression = parseExpression(code, { plugins: ['typescript'] })
  }
  catch {
    return undefined
  }

  const walk = (value: unknown, inParameters: boolean): void => {
    if (Array.isArray(value)) {
      for (const child of value)
        walk(child, inParameters)

      return
    }

    if (typeof value !== 'object' || value === null || typeof (value as { type?: unknown }).type !== 'string')
      return

    const node = value as t.Node

    if (inParameters && node.type === 'Identifier')
      names.add(node.name)

    for (const [key, child] of Object.entries(node))
      walk(child, inParameters || ((node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') && key === 'params'))
  }

  walk(expression, false)

  return names
}

// The names a pattern or a parameter list (`{ a: b }, [c], ...d` or `x: typeof y`) binds: a key or a type it holds binds none. Every word of it when it does not parse.
function bindingNames(pattern: string): string[] {
  const names: string[] = []
  let expression: t.Expression

  try {
    expression = parseExpression(`(${pattern}\n) => 0`, { plugins: ['typescript'] })
  }
  catch {
    return pattern.match(WORD) ?? []
  }

  const walk = (node: t.Node | null | undefined): void => {
    if (node?.type === 'Identifier') {
      names.push(node.name)
    }
    else if (node?.type === 'ObjectPattern') {
      for (const property of node.properties)
        walk(property.type === 'RestElement' ? property : property.value)
    }
    else if (node?.type === 'ArrayPattern') {
      for (const element of node.elements)
        walk(element)
    }
    else if (node?.type === 'AssignmentPattern') {
      walk(node.left)
    }
    else if (node?.type === 'RestElement') {
      walk(node.argument)
    }
  }

  if (expression.type === 'ArrowFunctionExpression') {
    for (const param of expression.params)
      walk(param)
  }

  return names
}

const reads = new WeakMap<KayFile, string[]>()

// The values of `kay` the template's expressions read, bar the names the template binds itself and the ones a function in an expression takes as parameters: the script declares the rest or leaves them to the compiler to import. A binder or a parameter hides its name file-wide, not only where it is in scope, so a file mixing both uses of one name imports it from the script.
export function templateReads(file: KayFile): string[] {
  const known = reads.get(file)

  if (known)
    return known

  const found = readsOf(file)

  reads.set(file, found)

  return found
}

function readsOf(file: KayFile): string[] {
  const bound = new Set<string>()
  const read = new Set<string>()
  const text = (span: Span) => file.source.slice(span.start, span.end)

  visitNodes(file.template, (node) => {
    const own = binders(node)

    for (const span of own) {
      for (const name of text(span).match(WORD) ?? [])
        bound.add(name)
    }

    for (const span of nodeExpressions(node)) {
      if (own.includes(span))
        continue

      const expression = text(span)
      const names = codeOf(expression).match(KAY_NAME)

      if (names === null)
        continue

      const shadowed = parameters(expression)

      for (const name of names) {
        if (!shadowed?.has(name))
          read.add(name)
      }
    }
  })

  return [...read].filter(name => !bound.has(name))
}

// The child blocks of a node with the spans naming what each sees besides its parent's names: a loop's item and index, a snippet's or slot's parameters, a branch's alias.
function scopedBlocks(node: Node): [Node[], Span[]][] {
  switch (node.kind) {
    case 'for':
      return [[node.children, node.index ? [node.item, node.index] : [node.item]], [node.fallback ?? [], []]]
    case 'snippet':
      return [[node.children, [node.params]]]
    case 'slot':
      return [[node.children, node.params ? [node.params] : []]]
    case 'if':
      return [...node.branches.map((branch): [Node[], Span[]] => [branch.children, branch.alias ? [branch.alias] : []]), [node.fallback?.children ?? [], []]]
    case 'await':
      return [[node.pending, []], [node.resolved?.children ?? [], node.resolved?.alias ? [node.resolved.alias] : []], [node.rejected?.children ?? [], node.rejected?.alias ? [node.rejected.alias] : []]]
    case 'try':
      return [[node.children, []], [node.rejected?.children ?? [], node.rejected?.alias ? [node.rejected.alias] : []]]
    case 'const':
    case 'element':
    case 'error':
    case 'match':
    case 'pending':
    case 'text':
      break
  }

  return childBlocks(node).map((block): [Node[], Span[]] => [block, []])
}

// The `bind:` attributes of a component whose expression starts with a name the template declares where it stands, a loop variable, a snippet parameter or a `const`: it is that value, not the prop of the same name.
export function shadowedBinds(file: KayFile): WeakSet<Attribute> {
  const shadowed = new WeakSet<Attribute>()
  const text = (span: Span) => file.source.slice(span.start, span.end)
  const names = (spans: Span[]) => spans.flatMap(span => bindingNames(text(span)))

  const walk = (nodes: readonly Node[], scope: ReadonlySet<string>): void => {
    const here = new Set(scope)

    for (const node of nodes) {
      if (node.kind === 'const') {
        for (const name of names([node.pattern]))
          here.add(name)

        continue
      }

      if (node.kind === 'element' && node.component) {
        for (const attribute of node.attributes) {
          if (attribute.kind === 'expression' && text(attribute.name).startsWith('bind:') && here.has(FIRST_NAME.exec(text(attribute.expression))?.[1] ?? ''))
            shadowed.add(attribute)
        }
      }

      for (const [block, spans] of scopedBlocks(node))
        walk(block, new Set([...here, ...names(spans)]))
    }
  }

  walk(file.template, new Set())

  return shadowed
}

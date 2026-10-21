import type * as t from '@babel/types'
import type { KayFile, Node, Span } from './ast'
import { parseExpression } from '@babel/parser'
import { nodeExpressions, visitNodes } from './ast'
import { codeOf, KAY_NAME } from './script'

const WORD = /[\w$]+/g

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

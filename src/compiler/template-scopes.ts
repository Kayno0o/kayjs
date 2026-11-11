import type { KayFile, Node, Span } from './ast'
import { childBlocks } from './ast'

// A stretch of the source in which the template binds names of its own: a loop's row, a block's parameters, a `then` value, a `const` for the lines after it.
export interface Scope {
  start: number
  end: number
  names: ReadonlySet<string>
}

const WORD = /[\w$]+/g

function namesOf(source: string, span: Span | undefined): string[] {
  return span === undefined ? [] : source.slice(span.start, span.end).match(WORD) ?? []
}

function stretch(nodes: readonly Node[]): [number, number] | undefined {
  const first = nodes[0]
  const last = nodes.at(-1)

  return first === undefined || last === undefined ? undefined : [first.start, last.end]
}

function bind(scopes: Scope[], nodes: readonly Node[], names: string[]): void {
  const range = stretch(nodes)

  if (range !== undefined && names.length > 0)
    scopes.push({ start: range[0], end: range[1], names: new Set(names) })
}

function visit(source: string, nodes: readonly Node[], scopes: Scope[]): void {
  const blockEnd = nodes.at(-1)?.end ?? 0

  for (const node of nodes) {
    switch (node.kind) {
      case 'const':
        scopes.push({ start: node.end, end: blockEnd, names: new Set(namesOf(source, node.pattern)) })

        break
      case 'snippet':
        scopes.push({ start: node.start, end: blockEnd, names: new Set(namesOf(source, node.name)) })
        bind(scopes, node.children, namesOf(source, node.params))

        break
      case 'for':
        bind(scopes, node.children, [...namesOf(source, node.item), ...namesOf(source, node.index)])

        break
      case 'slot':
        bind(scopes, node.children, namesOf(source, node.params))

        break
      case 'await':
        bind(scopes, node.resolved?.children ?? [], namesOf(source, node.resolved?.alias))
        bind(scopes, node.rejected?.children ?? [], namesOf(source, node.rejected?.alias))

        break
      case 'try':
        bind(scopes, node.rejected?.children ?? [], namesOf(source, node.rejected?.alias))

        break
      case 'if':
        for (const branch of node.branches)
          bind(scopes, branch.children, namesOf(source, branch.alias))

        break
      case 'element':
      case 'error':
      case 'match':
      case 'pending':
      case 'text':
        break
    }

    for (const block of childBlocks(node))
      visit(source, block, scopes)
  }
}

// The names the template binds and where each is bound, so a name read in the template can be told from the one a fence declares.
export function templateScopes(file: KayFile): Scope[] {
  const scopes: Scope[] = []

  visit(file.source, file.template, scopes)

  return scopes
}

// Whether the template binds `name` at `offset`.
export function boundAt(scopes: readonly Scope[], name: string, offset: number): boolean {
  return scopes.some(scope => offset >= scope.start && offset < scope.end && scope.names.has(name))
}

// The spans of a template that are prose: text and `markdown` lines, where a name is a word and no expression reads it.
export function proseSpans(file: KayFile): Span[] {
  const spans: Span[] = []

  const collect = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (node.kind === 'text')
        spans.push(...node.parts.filter(part => part.kind === 'chunk'))
      else if (node.kind === 'element' && node.markdown !== undefined)
        spans.push(node.markdown)

      for (const block of childBlocks(node))
        collect(block)
    }
  }

  collect(file.template)

  return spans
}

// Whether the file declares `name` as a value before `at`: a `const`, a prop or an import at the start of a line of a fence, or a name the template binds there. A declaration indented inside a function or a block is no name of the template.
export function declaredBefore(source: string, name: string, at: number, scopes: readonly Scope[]): boolean {
  if (boundAt(scopes, name, at))
    return true

  const word = name.replaceAll('$', '\\$')
  const line = '^(?:export[ \\t]+)?(?:async[ \\t]+)?'
  const found = new RegExp(`${line}(?:const|let|var|function|snippet|class)[ \\t]+${word}(?![\\w$])|${line}import[ \\t]+(?:type[ \\t]+)?${word}(?![\\w$])|${line}(?:const|let|var|import)\\b[^\\n]*[{\\[,][ \\t]*${word}[ \\t]*(?:[,}\\]:=]|as\\b)`, 'm').exec(source)

  return found !== null && found.index < at
}

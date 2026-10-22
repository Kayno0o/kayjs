import type * as t from '@babel/types'
import type { ElementNode, Node, Span } from '../compiler/ast'
import type { DocumentSymbol, FoldingRange, Range } from './protocol'
import { childBlocks } from '../compiler/ast'
import { parseKay } from '../compiler/parser'
import { analyzeScript, analyzeServer } from '../compiler/script'
import { toPosition } from './positions'

const MODULE = 2
const NAMESPACE = 3
const CLASS = 5
const PROPERTY = 7
const FUNCTION = 12
const VARIABLE = 13
const CONSTANT = 14
const STRUCT = 23
const WHITESPACE = /\s/
const SIGNALS = new Set(['signal', 'memo'])

// The outline of a `.kay` file: its fences with the names they declare, then the template's components and blocks.
export function documentSymbols(source: string): DocumentSymbol[] {
  const file = parseKay(source)
  const rangeOf = (start: number, end: number): Range => ({ start: toPosition(source, start), end: toPosition(source, end) })
  const symbol = (name: string, kind: number, span: Span, header: Span = span, detail?: string, children?: DocumentSymbol[]): DocumentSymbol => {
    const range = rangeOf(span.start, span.end)
    const selectionEnd = Math.min(header.end, endOfLine(source, header.start), span.end)

    return { name, kind, range, selectionRange: rangeOf(header.start, selectionEnd), ...detail !== undefined && { detail }, ...children !== undefined && children.length > 0 && { children } }
  }
  const fences: { label: string, span: Span, declared: DocumentSymbol[] }[] = []

  if (file.server) {
    const analysis = analyzeServer(source, file.server)

    fences.push({ label: 'server', span: file.server, declared: analysis?.fence ? declarations(analysis.fence, symbol, new Set(analysis.exportNames)) : [] })
  }

  if (file.script) {
    const analysis = analyzeScript(source, file.script)

    fences.push({ label: file.client ? 'client' : 'script', span: file.script, declared: analysis.fence ? declarations(analysis.fence, symbol) : [] })
  }

  if (file.module) {
    const analysis = analyzeScript(source, file.module)

    fences.push({ label: 'module', span: file.module, declared: analysis.fence ? declarations(analysis.fence, symbol) : [] })
  }

  const fenced = fences.sort((first, second) => first.span.start - second.span.start).map(({ label, span, declared }) => symbol(label, MODULE, { start: fenceLineStart(source, span.start), end: span.end }, { start: fenceLineStart(source, span.start), end: span.start }, undefined, declared))
  const template = file.template.flatMap(node => nodeSymbols(node, source, symbol))

  return [...fenced, ...template]
}

type MakeSymbol = (name: string, kind: number, span: Span, header?: Span, detail?: string, children?: DocumentSymbol[]) => DocumentSymbol

// The top-level names of a fence: props, signals, actions, functions and variables.
function declarations(fence: { ast: { program: t.Program }, shift: (node: t.Node) => Span }, symbol: MakeSymbol, actions = new Set<string>()): DocumentSymbol[] {
  const found: DocumentSymbol[] = []

  for (const statement of fence.ast.program.body) {
    const declaration = (statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement) ?? undefined

    if (declaration?.type === 'FunctionDeclaration' && declaration.id) {
      found.push(symbol(declaration.id.name, FUNCTION, fence.shift(statement), fence.shift(declaration.id)))
    }
    else if (declaration?.type === 'ClassDeclaration' && declaration.id) {
      found.push(symbol(declaration.id.name, CLASS, fence.shift(statement), fence.shift(declaration.id)))
    }
    else if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        const init = declarator.init
        const callee = init?.type === 'CallExpression' && init.callee.type === 'Identifier' ? init.callee.name : undefined
        const span = fence.shift(statement)

        if (callee === 'props' && declarator.id.type === 'ObjectPattern') {
          found.push(...declarator.id.properties.flatMap(property => property.type === 'ObjectProperty' && property.key.type === 'Identifier' ? [symbol(property.key.name, PROPERTY, fence.shift(property), fence.shift(property.key), 'prop')] : []))
        }
        else if (declarator.id.type === 'Identifier') {
          const name = declarator.id.name
          const callable = init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression'

          found.push(symbol(name, callable ? FUNCTION : variableKind(declaration.kind), span, fence.shift(declarator.id), detailOf(callee, actions.has(name))))
        }
      }
    }
  }

  return found
}

function variableKind(kind: string): number {
  return kind === 'const' ? CONSTANT : VARIABLE
}

function detailOf(callee: string | undefined, action: boolean): string | undefined {
  if (action)
    return 'action'

  return callee !== undefined && (callee === 'props' || SIGNALS.has(callee)) ? callee : undefined
}

function nodeSymbols(node: Node, source: string, symbol: MakeSymbol): DocumentSymbol[] {
  const text = (span: Span) => source.slice(span.start, span.end).trim()
  const inside = (blocks: Node[][]) => blocks.flatMap(block => block.flatMap(child => nodeSymbols(child, source, symbol)))
  const headerLine = (name: string, kind: number, span: Span, blocks: Node[][]) => [symbol(name, kind, span, span, undefined, inside(blocks))]

  switch (node.kind) {
    case 'element':
      return elementSymbols(node, source, symbol)
    case 'text':
      return inside(childBlocks(node))
    case 'if':
      return [
        ...node.branches.map((branch, index) => symbol(`${index === 0 ? 'if' : 'else if'} ${text(branch.test)}`, STRUCT, branch, branch, undefined, inside([branch.children]))),
        ...node.fallback ? [symbol('else', STRUCT, node.fallback, node.fallback, undefined, inside([node.fallback.children]))] : [],
      ]
    case 'match':
      return [
        symbol(`match ${text(node.subject)}`, STRUCT, node, node, undefined, [
          ...node.cases.map(branch => symbol(`when ${text(branch.test)}`, STRUCT, branch, branch, undefined, inside([branch.children]))),
          ...node.fallback ? [symbol('else', STRUCT, node.fallback, node.fallback, undefined, inside([node.fallback.children]))] : [],
        ]),
      ]
    case 'for':
      return headerLine(`for ${text(node.item)} of ${text(node.each)}`, STRUCT, node, [node.children, node.fallback ?? []])
    case 'await':
      return headerLine(`await ${text(node.value)}`, STRUCT, node, [node.pending, node.resolved?.children ?? [], node.rejected?.children ?? []])
    case 'try':
      return headerLine('try', STRUCT, node, [node.children, node.rejected?.children ?? []])
    case 'pending':
      return headerLine('pending', STRUCT, node, [node.children])
    case 'slot':
      return headerLine(`@${text(node.name)}${node.params ? `(${text(node.params)})` : ''}`, PROPERTY, node, [node.children])
    case 'snippet':
      return headerLine(`snippet ${text(node.name)}(${text(node.params)})`, FUNCTION, node, [node.children])
    case 'const':
      return [symbol(text(node.pattern), CONSTANT, node, node, 'const')]
    case 'error':
      return []
  }
}

// Components, elements with an id and the `slot` outlets are named; any other element only holds what is under it.
function elementSymbols(element: ElementNode, source: string, symbol: MakeSymbol): DocumentSymbol[] {
  const children = element.children.flatMap(child => nodeSymbols(child, source, symbol))

  if (element.outlet)
    return [symbol(`slot ${source.slice(element.outlet.name.start, element.outlet.name.end)}`, NAMESPACE, element, element, undefined, children)]

  if (element.component)
    return [symbol(element.name, CLASS, element, element, undefined, children)]

  if (element.id)
    return [symbol(`${element.name}${source.slice(element.id.start - 1, element.id.end)}`, STRUCT, element, element, undefined, children)]

  return children
}

// The folds of a `.kay` file: its fences and every template node spanning lines.
export function foldingRanges(source: string): FoldingRange[] {
  const file = parseKay(source)
  const lineOf = (offset: number) => toPosition(source, offset).line
  const folds: FoldingRange[] = []
  const fold = (start: number, end: number, kind?: FoldingRange['kind']) => {
    const startLine = lineOf(start)
    const endLine = lineOf(Math.max(start, trimmedEnd(source, end)))

    if (endLine > startLine)
      folds.push({ startLine, endLine, ...kind && { kind } })
  }

  for (const span of [file.server, file.script, file.module]) {
    if (span)
      fold(fenceLineStart(source, span.start), span.end, 'region')
  }

  const visit = (nodes: readonly Node[]) => {
    for (const node of nodes) {
      fold(node.start, node.end)

      if (node.kind === 'if') {
        for (const branch of node.branches)
          fold(branch.start, branch.end)
      }
      else if (node.kind === 'match') {
        for (const branch of node.cases)
          fold(branch.start, branch.end)
      }

      for (const block of childBlocks(node))
        visit(block)
    }
  }

  visit(file.template)

  const seen = new Set<string>()

  return folds.filter(({ startLine, endLine }) => {
    const key = `${startLine}:${endLine}`
    const fresh = !seen.has(key)

    seen.add(key)

    return fresh
  })
}

// Where the `---` line opening a fence starts: its body begins on the line after.
function fenceLineStart(source: string, bodyStart: number): number {
  return source.lastIndexOf('\n', Math.max(0, bodyStart - 2)) + 1
}

function endOfLine(source: string, offset: number): number {
  const end = source.indexOf('\n', offset)

  return end === -1 ? source.length : end - (source[end - 1] === '\r' ? 1 : 0)
}

// A span may end after the line break of its last line, which the fold stops short of.
function trimmedEnd(source: string, end: number): number {
  let trimmed = end

  while (trimmed > 0 && WHITESPACE.test(source[trimmed - 1]!))
    trimmed--

  return trimmed
}

import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Node, Span } from '../compiler/ast'
import type { ImportedSignals, SignalKind } from '../compiler/module-signals'
import type { ParsedFence } from '../compiler/script'
import { parse } from '@babel/parser'
import { nodeExpressions } from '../compiler/ast'
import { MADE } from '../compiler/module-signals'
import { parseKay } from '../compiler/parser'
import { patternNames } from '../compiler/pattern-names'
import { loadTraverse } from '../compiler/rewrite'
import { analyzeScript, analyzeServer } from '../compiler/script'
import { bindingNames, scopedBlocks } from '../compiler/template-reads'

// Standard types and modifiers, so a theme colours them without knowing kay; `signal`, `prop` and `server` are kay's own, which a theme or the user's `semanticTokenColorCustomizations` may style.
export const TOKEN_TYPES = ['variable', 'property', 'function']
export const TOKEN_MODIFIERS = ['declaration', 'readonly', 'signal', 'prop', 'server']

const VARIABLE = 0
const PROPERTY = 1
const FUNCTION = 2
const DECLARATION = 1
const READONLY = 2
const SIGNAL = 4
const PROP = 8
const SERVER = 16

// What a name is to the file: the token its declaration, reads and writes get.
interface Category {
  type: number
  modifiers: number
}

interface Token extends Span {
  type: number
  modifiers: number
}

type Categories = Map<string, Category>

const LOOSE_IMPORT = /\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*(["'])([^"']+)\2/g
const LOOSE_SPECIFIER = /([\w$]+)(?:\s+as\s+([\w$]+))?/g
const LOOSE_MADE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*[(<]/g
const LOOSE_PROPS = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*props\s*[(<]/g
const LOOSE_PROP = /(?:^|,)\s*(?:[\w$]+\s*:\s*)?([A-Z_$][\w$]*)/gi

const TYPE_PARENTS = new Set(['TSTypeReference', 'TSQualifiedName', 'TSTypeQuery'])

// The tokens of a `.kay` file as the protocol encodes them: its signals, props and server values wherever they are declared, read or written, in the script, the module and the template.
export function semanticTokens(source: string, imported: ImportedSignals = {}): number[] {
  const file = parseKay(source)
  const tokens = new Map<number, Token>()
  const add = (span: Span, category: Category, declaration = false) => tokens.set(span.start, { ...span, type: category.type, modifiers: category.modifiers | (declaration ? DECLARATION : 0) })
  const server: Categories = new Map()
  const outer: Categories = new Map()

  if (file.server) {
    const fence = analyzeServer(source, file.server)?.fence

    if (fence)
      fenceTokens(fence, new Map(), undefined, add, server, new Map(), new Set())
  }

  const own: Categories = new Map()
  // What each name imported by a fence makes: a signal made through `kay`, whatever its alias, and no signal when another module's.
  const made = new Map<string, SignalKind | undefined>()
  const plain = new Set<string>()
  const analyses = [file.module, file.script].flatMap((span) => {
    const analysis = span ? analyzeScript(source, span) : undefined

    return span && analysis ? [{ span, analysis, fence: analysis.fence }] : []
  })
  const fences = analyses.flatMap(({ analysis, fence }) => fence ? [{ analysis, fence }] : [])

  for (const { span, analysis, fence } of analyses) {
    for (const binding of analysis.imports) {
      const kind = imported[binding.source]?.[binding.imported]

      made.set(binding.local, binding.source === 'kay' && Object.hasOwn(MADE, binding.imported) ? MADE[binding.imported] : undefined)

      if (kind)
        own.set(binding.local, signalCategory(kind))
    }

    // What Babel could not parse is read as text, so the names it declares still reach the template.
    for (const region of fence ? fence.broken : [span])
      looseDeclarations(source, region, imported, made, own, add)

    for (const binding of analysis.props?.bindings ?? []) {
      const name = source.slice(binding.local.start, binding.local.end)

      own.set(name, { type: PROPERTY, modifiers: PROP | (binding.signal ? SIGNAL | (binding.signal === 'memo' ? READONLY : 0) : 0) })
    }
  }

  // The module fence goes first, so the script reads its signals.
  for (const { fence } of fences) {
    const declared: Categories = new Map()

    fenceTokens(fence, own, server, add, declared, made, plain)

    for (const [name, category] of declared) {
      own.set(name, category)
      outer.set(name, category)
    }
  }

  // A name the script declares itself is no longer the server fence's.
  const known = new Map([...[...server].filter(([name]) => !plain.has(name)), ...outer, ...own])

  walkTemplate(source, file.template, known, new Set(), add)

  return encode(source, [...tokens.values()].toSorted((a, b) => a.start - b.start))
}

// What calling the name makes: by the `kay` import it comes from, else by its own name since a file may use `signal` with no import.
function madeBy(callee: string, made: ReadonlyMap<string, SignalKind | undefined>): SignalKind | undefined {
  if (made.has(callee))
    return made.get(callee)

  return Object.hasOwn(MADE, callee) ? MADE[callee] : undefined
}

function signalCategory(kind: 'signal' | 'memo' | 'live'): Category {
  return { type: VARIABLE, modifiers: SIGNAL | (kind === 'signal' ? 0 : READONLY) }
}

// Marks the names a fence declares at its top level, and every read or write of them; `known` holds those of the module that the code reads without declaring, which the server fence hands the script. The categories of what the fence declares are put in `declared`.
function fenceTokens(fence: ParsedFence, known: Categories, handed: Categories | undefined, add: (span: Span, category: Category, declaration: boolean) => void, declared: Categories, made: ReadonlyMap<string, SignalKind | undefined>, plain: Set<string>): void {
  const program = fence.ast.program
  const own = new Map<string, Category>()

  for (const statement of program.body) {
    const declaration = (statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement) ?? undefined

    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers)
        plain.add(specifier.local.name)
    }

    if ((declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') && declaration.id)
      plain.add(declaration.id.name)

    if (declaration?.type === 'FunctionDeclaration' && declaration.id) {
      own.set(declaration.id.name, { type: FUNCTION, modifiers: handed ? 0 : SERVER })
    }
    else if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        const init = declarator.init
        const callee = init?.type === 'CallExpression' && init.callee.type === 'Identifier' ? init.callee.name : undefined
        const kind = callee === undefined ? undefined : madeBy(callee, made)
        const names = patternNames(declarator.id)
        const callable = init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression'

        for (const name of callee === 'props' ? [] : names) {
          plain.add(name)

          if (kind && handed)
            own.set(name, signalCategory(kind))
          else if (!handed)
            own.set(name, { type: callable ? FUNCTION : VARIABLE, modifiers: SERVER | (declaration.kind === 'const' ? READONLY : 0) })
        }
      }
    }
  }

  for (const [name, category] of own)
    declared.set(name, category)

  const categoryOf = (path: NodePath<t.Identifier>): Category | undefined => {
    const binding = path.scope.getBinding(path.node.name)

    // Babel gives a destructured `catch` parameter no binding.
    if (binding === undefined && path.isBindingIdentifier())
      return undefined

    if (binding === undefined)
      return known.get(path.node.name) ?? handed?.get(path.node.name)

    return binding.scope.path.isProgram() ? own.get(path.node.name) ?? known.get(path.node.name) : undefined
  }

  // Babel refuses a name declared twice, as an import and a `const` of one name, which an edit passes through: the fence then has no tokens.
  try {
    loadTraverse()(fence.ast, {
      Identifier(path) {
        const category = categoryOf(path)

        if (category && isNameSite(path))
          add(fence.shift(path.node), category, path.isBindingIdentifier() && path.scope.getBinding(path.node.name)?.identifier === path.node)
      },
    })
  }
  catch {}
}

// Whether the identifier is a use of the name: a declaration, a read or the left of an assignment, not a property key, a member or a type.
function isNameSite(identifier: NodePath<t.Identifier>): boolean {
  const path: NodePath = identifier
  const parent = path.parent

  if (TYPE_PARENTS.has(parent.type) || path.findParent(ancestor => ancestor.isTSType()))
    return false

  if (path.isReferencedIdentifier() || path.isBindingIdentifier())
    return true

  return (parent.type === 'AssignmentExpression' || parent.type === 'AssignmentPattern') && parent.left === path.node
}

// The template's expressions in scope order: what a loop, a snippet, a slot, an `if` alias or a `const` binds hides the name of the file inside its block.
function walkTemplate(source: string, nodes: Node[], known: Categories, hidden: ReadonlySet<string>, add: (span: Span, category: Category) => void): void {
  let shadowed: ReadonlySet<string> = hidden

  for (const node of nodes) {
    const binders = binderSpans(node)

    for (const span of nodeExpressions(node)) {
      if (!binders.includes(span))
        expressionTokens(source, span, known, shadowed, add)
    }

    for (const [block, spans] of scopedBlocks(node)) {
      const inner = new Set(shadowed)

      for (const span of spans) {
        for (const name of bindingNames(source.slice(span.start, span.end)))
          inner.add(name)
      }

      walkTemplate(source, block, known, inner, add)
    }

    if (node.kind === 'const') {
      shadowed = new Set([...shadowed, ...bindingNames(source.slice(node.pattern.start, node.pattern.end))])
    }
  }
}

function binderSpans(node: Node): Span[] {
  if (node.kind === 'const')
    return [node.pattern]

  if (node.kind === 'snippet')
    return [node.params]

  return node.kind === 'slot' && node.params ? [node.params] : []
}

function expressionTokens(source: string, span: Span, known: Categories, hidden: ReadonlySet<string>, add: (span: Span, category: Category) => void): void {
  let file: ReturnType<typeof parse>

  // Parenthesized, so an object literal is the expression and not a block; the columns are one off.
  try {
    file = parse(`(${source.slice(span.start, span.end)})`, { plugins: ['typescript'] })
  }
  catch {
    return
  }

  loadTraverse()(file, {
    Identifier(path) {
      // What the expression itself declares, a destructured `catch` parameter included, is never the file's.
      const category = hidden.has(path.node.name) || path.isBindingIdentifier() || path.scope.getBinding(path.node.name) ? undefined : known.get(path.node.name)

      if (category && isNameSite(path))
        add({ start: span.start + path.node.start! - 1, end: span.start + path.node.end! - 1 }, category)
    },
  })
}

// Declarations written in text Babel could not parse: a signal made by a call, a destructured `props` and the signals a fence imports. A name already known keeps its category.
function looseDeclarations(source: string, region: Span, imported: ImportedSignals, made: Map<string, SignalKind | undefined>, own: Categories, add: (span: Span, category: Category, declaration: boolean) => void): void {
  const text = source.slice(region.start, region.end)
  const declare = (name: string, at: number, category: Category) => {
    if (!own.has(name))
      own.set(name, category)

    add({ start: region.start + at, end: region.start + at + name.length }, category, true)
  }

  for (const match of text.matchAll(LOOSE_IMPORT)) {
    for (const specifier of match[1]!.matchAll(LOOSE_SPECIFIER)) {
      const local = specifier[2] ?? specifier[1]!
      const kind = imported[match[3]!]?.[specifier[1]!]

      if (match[3] === 'kay' && Object.hasOwn(MADE, specifier[1]!))
        made.set(local, MADE[specifier[1]!])

      if (kind)
        declare(local, match.index + match[0].indexOf(match[1]!) + specifier.index + specifier[0].lastIndexOf(local), signalCategory(kind))
    }
  }

  for (const match of text.matchAll(LOOSE_MADE)) {
    const kind = madeBy(match[2]!, made)

    if (kind)
      declare(match[1]!, match.index + match[0].indexOf(match[1]!), signalCategory(kind))
  }

  for (const match of text.matchAll(LOOSE_PROPS)) {
    for (const entry of match[1]!.matchAll(LOOSE_PROP)) {
      const name = entry[1]!

      declare(name, match.index + match[0].indexOf('{') + 1 + entry.index + entry[0].lastIndexOf(name), { type: PROPERTY, modifiers: PROP })
    }
  }
}

function encode(source: string, tokens: Token[]): number[] {
  const data: number[] = []
  const lineStarts = [0]

  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1))
    lineStarts.push(at + 1)

  let line = 0
  let previous = { line: 0, character: 0 }

  for (const token of tokens) {
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= token.start)
      line++

    const character = token.start - lineStarts[line]!

    data.push(line - previous.line, line === previous.line ? character - previous.character : character, token.end - token.start, token.type, token.modifiers)
    previous = { line, character }
  }

  return data
}

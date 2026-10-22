import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Node, Span } from '../compiler/ast'
import type { ImportedSignals } from '../compiler/module-signals'
import type { ParsedFence } from '../compiler/script'
import { parseExpression } from '@babel/parser'
import { nodeExpressions } from '../compiler/ast'
import { MADE } from '../compiler/module-signals'
import { parseKay } from '../compiler/parser'
import { loadTraverse } from '../compiler/rewrite'
import { analyzeScript, analyzeServer } from '../compiler/script'
import { bindingNames, scopedBlocks } from '../compiler/template-reads'
import { toPosition } from './positions'

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
      fenceTokens(fence, new Map(), undefined, (span, category, declaration) => add(span, category, declaration), server)
  }

  const own: Categories = new Map()
  const fences = [file.module, file.script].flatMap((span) => {
    const analysis = span ? analyzeScript(source, span) : undefined

    return span && analysis?.fence ? [{ analysis, fence: analysis.fence }] : []
  })

  for (const { analysis } of fences) {
    for (const binding of analysis.imports) {
      const kind = imported[binding.source]?.[binding.imported]

      if (kind)
        own.set(binding.local, signalCategory(kind))
    }

    for (const binding of analysis.props?.bindings ?? []) {
      const name = source.slice(binding.local.start, binding.local.end)

      own.set(name, { type: PROPERTY, modifiers: PROP | (binding.signal ? SIGNAL | (binding.signal === 'memo' ? READONLY : 0) : 0) })
    }
  }

  for (const { fence } of fences)
    fenceTokens(fence, own, server, (span, category, declaration) => add(span, category, declaration), outer)

  const known = new Map([...server, ...outer, ...own])

  walkTemplate(source, file.template, known, new Set(), add)

  return encode(source, [...tokens.values()].toSorted((a, b) => a.start - b.start))
}

function signalCategory(kind: 'signal' | 'memo' | 'live'): Category {
  return { type: VARIABLE, modifiers: SIGNAL | (kind === 'signal' ? 0 : READONLY) }
}

// Marks the names a fence declares at its top level, and every read or write of them; `known` holds those of the module that the code reads without declaring, which the server fence hands the script. The categories of what the fence declares are put in `declared`.
function fenceTokens(fence: ParsedFence, known: Categories, handed: Categories | undefined, add: (span: Span, category: Category, declaration: boolean) => void, declared: Categories): void {
  const program = fence.ast.program
  const own = new Map<string, Category>()

  for (const statement of program.body) {
    const declaration = (statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement) ?? undefined

    if (declaration?.type === 'FunctionDeclaration' && declaration.id) {
      own.set(declaration.id.name, { type: FUNCTION, modifiers: handed ? 0 : SERVER })
    }
    else if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        const init = declarator.init
        const callee = init?.type === 'CallExpression' && init.callee.type === 'Identifier' ? init.callee.name : undefined
        const made = callee === undefined ? undefined : MADE[callee]
        const names = declarator.id.type === 'Identifier' ? [declarator.id.name] : bindingIdentifiers(declarator.id)
        const callable = init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression'

        for (const name of callee === 'props' ? [] : names) {
          if (made && handed)
            own.set(name, signalCategory(made))
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

    if (binding === undefined)
      return handed?.get(path.node.name)

    return binding.scope.path.isProgram() ? own.get(path.node.name) ?? known.get(path.node.name) : undefined
  }

  loadTraverse()(fence.ast, {
    Identifier(path) {
      const category = categoryOf(path)

      if (category && isNameSite(path))
        add(fence.shift(path.node), category, path.isBindingIdentifier() && path.scope.getBinding(path.node.name)?.identifier === path.node)
    },
  })
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

// The names a declaration pattern binds.
function bindingIdentifiers(pattern: t.Node | null | undefined): string[] {
  if (pattern?.type === 'Identifier')
    return [pattern.name]

  if (pattern?.type === 'ObjectPattern')
    return pattern.properties.flatMap(property => bindingIdentifiers(property.type === 'RestElement' ? property : property.value))

  if (pattern?.type === 'ArrayPattern')
    return pattern.elements.flatMap(element => bindingIdentifiers(element))

  if (pattern?.type === 'AssignmentPattern')
    return bindingIdentifiers(pattern.left)

  return pattern?.type === 'RestElement' ? bindingIdentifiers(pattern.argument) : []
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
  let expression: t.Expression

  try {
    expression = parseExpression(source.slice(span.start, span.end), { plugins: ['typescript'] })
  }
  catch {
    return
  }

  const visit = (value: unknown, shadowed: ReadonlySet<string>, parent?: t.Node): void => {
    if (Array.isArray(value)) {
      for (const child of value)
        visit(child, shadowed, parent)

      return
    }

    if (typeof value !== 'object' || value === null || typeof (value as { type?: unknown }).type !== 'string')
      return

    const node = value as t.Node

    if (node.type === 'Identifier') {
      const category = shadowed.has(node.name) ? undefined : known.get(node.name)

      if (category && node.start != null)
        add({ start: span.start + node.start, end: span.start + node.start + node.name.length }, category)

      return
    }

    if (node.type.startsWith('TS') && node.type !== 'TSAsExpression' && node.type !== 'TSNonNullExpression' && node.type !== 'TSSatisfiesExpression')
      return

    const inner = node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' ? new Set([...shadowed, ...node.params.flatMap(param => bindingIdentifiers(param)), ...declaredIn(node.body)]) : shadowed

    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments')
        continue

      if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && key === 'property' && !node.computed)
        continue

      if ((node.type === 'ObjectProperty' || node.type === 'ObjectMethod') && key === 'key' && !node.computed && !(node.type === 'ObjectProperty' && node.shorthand))
        continue

      if (key === 'params' || key === 'returnType' || key === 'typeParameters' || key === 'typeAnnotation')
        continue

      visit(child, inner, node)
    }
  }

  visit(expression, hidden)
}

// The names a function body declares with `const`, `let` or `var` at any depth, which hide a file's name for the whole function.
function declaredIn(body: t.Node): string[] {
  const names: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value)
        visit(child)

      return
    }

    if (typeof value !== 'object' || value === null || typeof (value as { type?: unknown }).type !== 'string')
      return

    const node = value as t.Node

    if (node.type === 'VariableDeclarator')
      names.push(...bindingIdentifiers(node.id))

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'loc' && key !== 'extra')
        visit(child)
    }
  }

  visit(body)

  return names
}

function encode(source: string, tokens: Token[]): number[] {
  const data: number[] = []
  let line = 0
  let character = 0

  for (const token of tokens) {
    const at = toPosition(source, token.start)

    data.push(at.line - line, at.line === line ? at.character - character : at.character, token.end - token.start, token.type, token.modifiers)
    line = at.line
    character = at.character
  }

  return data
}

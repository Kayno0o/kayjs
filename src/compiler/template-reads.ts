import type { Attribute, KayFile, Node, Span } from './ast'
import type { Node as EstreeNode, Expression } from './estree'
import { childBlocks, nodeExpressions, visitNodes } from './ast'
import { parseExpression, VISITOR_KEYS } from './estree'
import { parsedBindingNames, patternNames } from './pattern-names'
import { codeOf } from './script'

const WORD = /[\w$]+/g
const FIRST_NAME = /^\s*([\w$]+)/

// The spans of a node that declare names for its children, which its expressions do not read.
export function binders(node: Node): Span[] {
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

// The TypeScript nodes that wrap a value, which a read of a name goes through; any other holds a type.
const TYPED_VALUES = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion'])
const IDENTIFIER = /(?<![\w$.])[A-Z_$][\w$]*/gi

// The nodes that open a scope for the names their parameters and declarations bind.
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'])

// The names a function body declares itself, not those of the functions inside it.
function declaredIn(value: unknown): string[] {
  if (Array.isArray(value))
    return value.flatMap(child => declaredIn(child))

  if (typeof value !== 'object' || value === null || typeof (value as { type?: unknown }).type !== 'string')
    return []

  const node = value as EstreeNode & { id?: EstreeNode | null }
  const own = node.type === 'VariableDeclarator' || node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' ? patternNames(node.id) : []

  return FUNCTIONS.has(node.type) ? own : [...own, ...(VISITOR_KEYS[node.type] ?? []).flatMap(key => declaredIn((node as unknown as Record<string, unknown>)[key]))]
}

// The names an expression reads: not a member after a dot, an object key, a type, or a name a function in it declares inside that function. Every word of the code when it does not parse.
export function readNames(code: string): Set<string> {
  let expression: Expression

  try {
    expression = parseExpression(code, { lang: 'ts' })
  }
  catch {
    return new Set(code.match(IDENTIFIER))
  }

  const names = new Set<string>()
  const walk = (value: unknown, scope: ReadonlySet<string>): void => {
    if (Array.isArray(value)) {
      for (const child of value)
        walk(child, scope)

      return
    }

    if (typeof value !== 'object' || value === null || typeof (value as { type?: unknown }).type !== 'string')
      return

    const node = value as EstreeNode & { computed?: boolean, id?: EstreeNode | null, params?: EstreeNode[], param?: EstreeNode | null, body?: unknown }

    if (node.type === 'Identifier') {
      if (!scope.has(node.name))
        names.add(node.name)

      return
    }

    if (node.type.startsWith('TS') && !TYPED_VALUES.has(node.type))
      return

    let inner = scope

    if (FUNCTIONS.has(node.type))
      inner = new Set([...scope, ...(node.params ?? []).flatMap(param => patternNames(param)), ...patternNames(node.id), ...declaredIn(node.body)])
    else if (node.type === 'CatchClause')
      inner = new Set([...scope, ...patternNames(node.param)])

    for (const child of VISITOR_KEYS[node.type] ?? []) {
      // A name written after a dot or as an object key reads nothing, unless computed.
      if (child === 'property' && node.type === 'MemberExpression' && !node.computed)
        continue

      if (child === 'key' && !node.computed && (node.type === 'Property' || node.type === 'MethodDefinition' || node.type === 'PropertyDefinition'))
        continue

      if (child === 'typeAnnotation' || child === 'typeArguments' || child === 'typeParameters')
        continue

      walk((node as unknown as Record<string, unknown>)[child], inner)
    }
  }

  walk(expression, new Set())

  return names
}

// The names the template's expressions read that nothing in the template declares where they stand: a loop item, a snippet parameter, a `const` or a branch alias hides a script's name only inside its own block.
export function outerReads(file: KayFile): string[] {
  const read = new Set<string>()
  const text = (span: Span) => file.source.slice(span.start, span.end)
  const walk = (nodes: readonly Node[], scope: ReadonlySet<string>): void => {
    const here = new Set(scope)

    for (const node of nodes) {
      const own = binders(node)

      for (const span of nodeExpressions(node)) {
        if (own.includes(span))
          continue

        for (const name of readNames(codeOf(text(span)))) {
          if (!here.has(name))
            read.add(name)
        }
      }

      if (node.kind === 'const') {
        for (const name of bindingNames(text(node.pattern)))
          here.add(name)

        continue
      }

      for (const [block, spans] of scopedBlocks(node))
        walk(block, new Set([...here, ...spans.flatMap(span => bindingNames(text(span)))]))
    }
  }

  walk(file.template, new Set())

  return [...read]
}

// The names of `parsedBindingNames`, or every word of the pattern when it does not parse.
export function bindingNames(pattern: string): string[] {
  return parsedBindingNames(pattern) ?? pattern.match(WORD) ?? []
}

// Every word the template's expressions write, which the names it reads are among: it over-approximates on purpose, as any word counts, so a check using it can only over-report.
export function templateWords(file: KayFile): string[] {
  const words = new Set<string>()

  visitNodes(file.template, (node) => {
    for (const span of nodeExpressions(node)) {
      for (const word of file.source.slice(span.start, span.end).match(WORD) ?? [])
        words.add(word)
    }
  })

  return [...words]
}

// The child blocks of a node with the spans naming what each sees besides its parent's names: a loop's item and index, a snippet's or slot's parameters, a branch's alias.
export function scopedBlocks(node: Node): [Node[], Span[]][] {
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

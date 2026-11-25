// Shared compiler helpers & JSX child/hydration IR classification used by both `ssr.ts` and `dom.ts`.

import type {
  ArrowFunctionExpression,
  BlockStatement,
  CallExpression,
  ConditionalExpression,
  Expression,
  Function as OxcFunction,
  JSXChild,
  JSXElement,
  JSXElementName,
  JSXExpressionContainer,
  JSXFragment,
  JSXNamespacedName,
  LogicalExpression,
  Node,
  ParamPattern,
  Program,
} from 'oxc-parser'
import { walk } from './analyze'

export { DOM_PROPS, isBlockedAttr, isStringBoolAttr, isUnsafeUrlAttr } from '../attrs'

export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

export const RAW_TEXT_ELEMENTS = new Set(['style', 'script'])
export const EVENT_ATTR = /^on([A-Z]\w*)$/

const CLOSE_STYLE_RE = /<\/(style)/gi
const SCRIPT_UNSAFE_RE = /<(\/script|script|!--)/gi
const LINE_BREAK_RE = /\r\n|\n|\r/

export function escapeRawText(str: string, tag: 'style' | 'script'): string {
  if (tag === 'script') {
    return str.replace(SCRIPT_UNSAFE_RE, (_, body: string) =>
      body.charCodeAt(0) === 47 ? `<\\${body}` : `\\u003c${body}`)
  }
  return str.replace(CLOSE_STYLE_RE, '<\\/$1')
}

export function escapeStaticText(str: string): string {
  return str.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function escapeStaticAttr(str: string): string {
  return escapeStaticText(str).replaceAll('"', '&quot;')
}

export function formatLoc(filename: string, code: string, offset?: number): string {
  if (offset === undefined || offset < 0)
    return filename
  let line = 1
  let col = 1
  const end = Math.min(offset, code.length)
  for (let i = 0; i < end; i++) {
    if (code.charCodeAt(i) === 10) {
      line++
      col = 1
    }
    else {
      col++
    }
  }
  return `${filename}:${line}:${col}`
}

export function cleanJsxText(raw: string): string {
  if (!LINE_BREAK_RE.test(raw))
    return raw
  const lines = raw.split(LINE_BREAK_RE)
  let out = ''
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.replace(/\t/g, ' ')
    if (i > 0)
      line = line.replace(/^ +/, '')
    if (i < lines.length - 1)
      line = line.replace(/ +$/, '')
    if (line !== '') {
      if (out !== '')
        out += ' '
      out += line
    }
  }
  return out
}

export function jsxTagName(node: JSXElementName | JSXNamespacedName | { type: 'JSXIdentifier', name: string }): string {
  if (node.type === 'JSXIdentifier')
    return node.name
  if (node.type === 'JSXMemberExpression')
    return `${jsxTagName(node.object)}.${node.property.name}`
  if (node.type === 'JSXNamespacedName')
    return `${node.namespace.name}:${node.name.name}`
  return ''
}

export function isComponentTag(tag: string): boolean {
  const first = tag.charCodeAt(0)
  return (first >= 65 && first <= 90) || tag.includes('.')
}

export function unwrapParens(node: Node): Node {
  let cur = node
  while (cur.type === 'ParenthesizedExpression')
    cur = cur.expression
  return cur
}

export function unwrapTsExpr(node: Node): Node {
  let cur = node
  while (
    cur.type === 'ParenthesizedExpression'
    || cur.type === 'TSAsExpression'
    || cur.type === 'TSSatisfiesExpression'
    || cur.type === 'TSNonNullExpression'
    || cur.type === 'TSTypeAssertion'
  ) {
    cur = cur.expression
  }
  return cur
}

export function staticLiteral(node: Node): { ok: true, value: string | number | boolean | null } | { ok: false } {
  const n = unwrapParens(node)
  if (n.type === 'Literal') {
    const v = n.value
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)
      return { ok: true, value: v }
  }
  if (n.type === 'UnaryExpression' && n.operator === '-' && n.argument.type === 'Literal' && typeof n.argument.value === 'number')
    return { ok: true, value: -n.argument.value }
  return { ok: false }
}

export function isJsxNode(node: Node | null | undefined): node is JSXElement | JSXFragment {
  return node?.type === 'JSXElement' || node?.type === 'JSXFragment'
}

/** Whether JSX appears anywhere inside `node`, itself included. */
export function containsJsx(node: Node | null | undefined): boolean {
  let found = false
  walk(node, (child) => {
    if (found)
      return false
    if (isJsxNode(child))
      found = true
    return undefined
  })
  return found
}

/** Whether a BlockStatement directly returns JSX (ignoring nested functions). */
export function blockReturnsJsx(block: BlockStatement): boolean {
  let found = false
  walk(block, (child) => {
    if (found)
      return false
    if (child !== block && (
      child.type === 'ArrowFunctionExpression'
      || child.type === 'FunctionExpression'
      || child.type === 'FunctionDeclaration'
    )) {
      return false
    }
    if (child.type === 'ReturnStatement' && child.argument !== null && containsJsx(child.argument)) {
      found = true
      return false
    }
    return undefined
  })
  return found
}

export function filterMeaningfulChildren(children: readonly JSXChild[]): JSXChild[] {
  return children.filter((c) => {
    if (c.type === 'JSXText')
      return cleanJsxText(c.value) !== ''
    if (c.type === 'JSXExpressionContainer' && c.expression.type === 'JSXEmptyExpression')
      return false
    // Empty string literal `{""}` produces zero DOM nodes on SSR and DOM alike.
    if (c.type === 'JSXExpressionContainer' && c.expression.type === 'Literal' && c.expression.value === '')
      return false
    return true
  })
}

export interface MapCallMatch {
  call: CallExpression
  target: Expression
  cb: ArrowFunctionExpression | OxcFunction
  body: JSXElement | JSXFragment | BlockStatement
  isJsxBody: boolean
  params: readonly ParamPattern[]
}

/** Recognizes `arr.map((item, idx?) => <jsx> | { ... return <jsx> })` identically in SSR and DOM compilers. */
export function matchJsxMapCall(expr: Node): MapCallMatch | undefined {
  if (
    expr.type !== 'CallExpression'
    || expr.callee.type !== 'MemberExpression'
    || expr.callee.computed
    || expr.callee.property.type !== 'Identifier'
    || expr.callee.property.name !== 'map'
    || expr.arguments.length !== 1
  ) {
    return undefined
  }
  const arg = expr.arguments[0]
  if (arg === undefined || (arg.type !== 'ArrowFunctionExpression' && arg.type !== 'FunctionExpression'))
    return undefined
  if (arg.async || arg.body === null)
    return undefined
  // 3rd `(item, idx, arr)` param or rest param cannot be mapped cleanly to `(item, idx)` loop signals.
  if (arg.params.length > 2 || arg.params.some(p => p.type === 'RestElement'))
    return undefined
  const body = unwrapParens(arg.body)
  if (isJsxNode(body))
    return { call: expr, target: expr.callee.object, cb: arg, body, isJsxBody: true, params: arg.params }
  if (body.type === 'BlockStatement' && blockReturnsJsx(body))
    return { call: expr, target: expr.callee.object, cb: arg, body, isJsxBody: false, params: arg.params }
  return undefined
}

export function isStaticBranch(node: Node): boolean {
  const n = unwrapParens(node)
  if (isJsxNode(n))
    return true
  if (n.type === 'Identifier' && n.name === 'undefined')
    return true
  return staticLiteral(n).ok
}

export type ChildSlotKind =
  | { kind: 'static-text', text: string, fromLiteral: boolean }
  | { kind: 'element', node: JSXElement }
  | { kind: 'component', node: JSXElement }
  | { kind: 'fragment', node: JSXFragment }
  | { kind: 'loop', match: MapCallMatch }
  | { kind: 'and-show', expr: LogicalExpression, right: JSXElement | JSXFragment }
  | { kind: 'ternary-show', expr: ConditionalExpression, cons: Node, alt: Node }
  | { kind: 'expr', container: JSXExpressionContainer, expr: Expression }

/**
 * Single shared child classifier for SSR & DOM codegen.
 * Both emitters derive exact hydration marker placement (`<!--k[-->...<!--k]-->` vs `<!---->`) from this classification.
 */
export function classifyJsxChild(child: JSXChild): ChildSlotKind | undefined {
  if (child.type === 'JSXText') {
    const text = cleanJsxText(child.value)
    return text === '' ? undefined : { kind: 'static-text', text, fromLiteral: false }
  }
  if (child.type === 'JSXFragment')
    return { kind: 'fragment', node: child }
  if (child.type === 'JSXElement') {
    const tag = jsxTagName(child.openingElement.name)
    return isComponentTag(tag)
      ? { kind: 'component', node: child }
      : { kind: 'element', node: child }
  }
  if (child.type === 'JSXExpressionContainer') {
    if (child.expression.type === 'JSXEmptyExpression')
      return undefined
    const expr = child.expression
    if (expr.type === 'Literal' && typeof expr.value === 'string') {
      return expr.value === ''
        ? undefined
        : { kind: 'static-text', text: expr.value, fromLiteral: true }
    }
    const mapMatch = matchJsxMapCall(expr)
    if (mapMatch !== undefined)
      return { kind: 'loop', match: mapMatch }
    if (expr.type === 'LogicalExpression' && expr.operator === '&&') {
      const right = unwrapParens(expr.right)
      if (isJsxNode(right))
        return { kind: 'and-show', expr, right }
    }
    if (expr.type === 'ConditionalExpression') {
      const cons = unwrapParens(expr.consequent)
      const alt = unwrapParens(expr.alternate)
      // Use `show()` only when at least one branch is JSX and the other branch is JSX or a static literal/nullish;
      // mixed dynamic text (`cond ? <span/> : count.value`) goes through `expr` (`insert`) so both branches stay reactive.
      if ((isJsxNode(cons) && isStaticBranch(alt)) || (isJsxNode(alt) && isStaticBranch(cons)))
        return { kind: 'ternary-show', expr, cons, alt }
    }
    return { kind: 'expr', container: child, expr }
  }
  return undefined
}

/** Collects every identifier name bound by a destructuring/parameter pattern. */
export function collectPatternNames(pattern: Node | null | undefined, out: Set<string>): void {
  if (pattern === null || pattern === undefined)
    return
  switch (pattern.type) {
    case 'Identifier':
      out.add(pattern.name)
      return
    case 'AssignmentPattern':
      collectPatternNames(pattern.left, out)
      return
    case 'RestElement':
      collectPatternNames(pattern.argument, out)
      return
    case 'TSParameterProperty':
      collectPatternNames(pattern.parameter, out)
      return
    case 'ArrayPattern':
      for (const el of pattern.elements) {
        if (el !== null)
          collectPatternNames(el, out)
      }
      return
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement')
          collectPatternNames(prop.argument, out)
        else
          collectPatternNames(prop.value, out)
      }
  }
}

const PRIMITIVE_GLOBALS = new Set([
  'String', 'Number', 'Boolean', 'parseInt', 'parseFloat',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
])

const PRIMITIVE_METHODS = new Set([
  'toString', 'toFixed', 'toPrecision', 'toExponential', 'toLocaleString',
  'toLocaleDateString', 'toLocaleTimeString', 'toISOString', 'toUpperCase',
  'toLowerCase', 'toLocaleUpperCase', 'toLocaleLowerCase', 'trim', 'trimStart',
  'trimEnd', 'join', 'padStart', 'padEnd', 'repeat', 'replace', 'replaceAll',
  'substring', 'substr', 'charAt', 'charCodeAt', 'codePointAt', 'indexOf',
  'lastIndexOf', 'includes', 'startsWith', 'endsWith', 'getTime', 'getFullYear',
  'getMonth', 'getDate', 'getHours', 'getMinutes', 'getSeconds',
])

function isKnownPrimitiveCall(node: CallExpression): boolean {
  const callee = node.callee
  if (callee.type === 'Identifier' && PRIMITIVE_GLOBALS.has(callee.name))
    return true
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    const prop = callee.property.name
    if (callee.object.type === 'Identifier') {
      const obj = callee.object.name
      if (obj === 'Math' || (obj === 'JSON' && prop === 'stringify') || (obj === 'Date' && prop === 'now'))
        return true
    }
    if (PRIMITIVE_METHODS.has(prop))
      return true
  }
  return false
}

export function mayReturnNode(node: Node): boolean {
  const cur = unwrapTsExpr(node)
  if (cur.type === 'CallExpression')
    return !isKnownPrimitiveCall(cur)
  if (cur.type === 'LogicalExpression')
    return mayReturnNode(cur.left) || mayReturnNode(cur.right)
  if (cur.type === 'ConditionalExpression')
    return mayReturnNode(cur.consequent) || mayReturnNode(cur.alternate)
  return false
}

/** Shared SSR/DOM check for whether a dynamic expression slot may produce DOM nodes/fragments (requiring balanced `<!--k[-->...<!--k]-->` markers). */
export function isNodeCapableExpr(expr: Expression): boolean {
  const isChildrenExpr = (expr.type === 'Identifier' && expr.name === 'children')
    || (expr.type === 'MemberExpression' && !expr.computed && expr.property.type === 'Identifier' && expr.property.name === 'children')
  return isChildrenExpr || containsJsx(expr) || mayReturnNode(expr)
}

export type { Program }

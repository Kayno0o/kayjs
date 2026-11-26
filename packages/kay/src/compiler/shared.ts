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
import { walk } from './ast'

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

const HTML_ENTITIES: Record<string, string> = {
  // Core XML/HTML & whitespace
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00A0',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200C', zwj: '\u200D', lrm: '\u200E', rlm: '\u200F', shy: '\u00AD',
  // Punctuation & symbols
  ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201A',
  ldquo: '\u201C', rdquo: '\u201D', bdquo: '\u201E', hellip: '\u2026', bull: '\u2022',
  middot: '\u00B7', laquo: '\u00AB', raquo: '\u00BB', lsaquo: '\u2039', rsaquo: '\u203A',
  prime: '\u2032', Prime: '\u2033', sect: '\u00A7', para: '\u00B6', dagger: '\u2020', Dagger: '\u2021', permil: '\u2030',
  iexcl: '\u00A1', iquest: '\u00BF', brvbar: '\u00A6', macr: '\u00AF', acute: '\u00B4', cedil: '\u00B8', uml: '\u00A8',
  ordf: '\u00AA', ordm: '\u00BA', not: '\u00AC', loz: '\u25CA',
  // Suits, stars & checkmarks
  spades: '\u2660', clubs: '\u2663', hearts: '\u2665', diams: '\u2666',
  star: '\u2606', check: '\u2713', checkmark: '\u2713', cross: '\u2717',
  // Currency & legal
  copy: '\u00A9', reg: '\u00AE', trade: '\u2122', euro: '\u20AC', pound: '\u00A3', yen: '\u00A5', cent: '\u00A2', curren: '\u00A4',
  // Math & arrows
  deg: '\u00B0', plusmn: '\u00B1', times: '\u00D7', divide: '\u00F7',
  frac12: '\u00BD', frac14: '\u00BC', frac34: '\u00BE', sup1: '\u00B9', sup2: '\u00B2', sup3: '\u00B3',
  micro: '\u00B5', minus: '\u2212', ne: '\u2260', le: '\u2264', ge: '\u2265', approx: '\u2248', infin: '\u221E',
  sum: '\u2211', prod: '\u220F', radic: '\u221A', int: '\u222B', part: '\u2202', empty: '\u2205', nabla: '\u2207',
  isin: '\u2208', notin: '\u2209', ni: '\u220B', cap: '\u2229', cup: '\u222A', sub: '\u2282', sup: '\u2283',
  nsub: '\u2284', sube: '\u2286', supe: '\u2287', oplus: '\u2295', otimes: '\u2297', perp: '\u22A5', sdot: '\u22C5',
  equiv: '\u2261', cong: '\u2245', asymp: '\u2248', prop: '\u221D', and: '\u2227', or: '\u2228', forall: '\u2200', exist: '\u2203',
  larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193', harr: '\u2194', crarr: '\u21B5',
  lArr: '\u21D0', uArr: '\u21D1', rArr: '\u21D2', dArr: '\u21D3', hArr: '\u21D4',
  // Greek
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394', Epsilon: '\u0395', Zeta: '\u0396', Eta: '\u0397', Theta: '\u0398',
  Iota: '\u0399', Kappa: '\u039A', Lambda: '\u039B', Mu: '\u039C', Nu: '\u039D', Xi: '\u039E', Omicron: '\u039F', Pi: '\u03A0',
  Rho: '\u03A1', Sigma: '\u03A3', Tau: '\u03A4', Upsilon: '\u03A5', Phi: '\u03A6', Chi: '\u03A7', Psi: '\u03A8', Omega: '\u03A9',
  alpha: '\u03B1', beta: '\u03B2', gamma: '\u03B3', delta: '\u03B4', epsilon: '\u03B5', zeta: '\u03B6', eta: '\u03B7', theta: '\u03B8',
  iota: '\u03B9', kappa: '\u03BA', lambda: '\u03BB', mu: '\u03BC', nu: '\u03BD', xi: '\u03BE', omicron: '\u03BF', pi: '\u03C0',
  rho: '\u03C1', sigmaf: '\u03C2', sigma: '\u03C3', tau: '\u03C4', upsilon: '\u03C5', phi: '\u03C6', chi: '\u03C7', psi: '\u03C8', omega: '\u03C9',
  // Latin-1 & European accents
  Agrave: '\u00C0', Aacute: '\u00C1', Acirc: '\u00C2', Atilde: '\u00C3', Auml: '\u00C4', Aring: '\u00C5', AElig: '\u00C6', Ccedil: '\u00C7',
  Egrave: '\u00C8', Eacute: '\u00C9', Ecirc: '\u00CA', Euml: '\u00CB', Igrave: '\u00CC', Iacute: '\u00CD', Icirc: '\u00CE', Iuml: '\u00CF',
  ETH: '\u00D0', Ntilde: '\u00D1', Ograve: '\u00D2', Oacute: '\u00D3', Ocirc: '\u00D4', Otilde: '\u00D5', Ouml: '\u00D6', Oslash: '\u00D8',
  Ugrave: '\u00D9', Uacute: '\u00DA', Ucirc: '\u00DB', Uuml: '\u00DC', Yacute: '\u00DD', THORN: '\u00DE', szlig: '\u00DF',
  agrave: '\u00E0', aacute: '\u00E1', acirc: '\u00E2', atilde: '\u00E3', auml: '\u00E4', aring: '\u00E5', aelig: '\u00E6', ccedil: '\u00E7',
  egrave: '\u00E8', eacute: '\u00E9', ecirc: '\u00EA', euml: '\u00EB', igrave: '\u00EC', iacute: '\u00ED', icirc: '\u00EE', iuml: '\u00EF',
  eth: '\u00F0', ntilde: '\u00F1', ograve: '\u00F2', oacute: '\u00F3', ocirc: '\u00F4', otilde: '\u00F5', ouml: '\u00F6', oslash: '\u00F8',
  ugrave: '\u00F9', uacute: '\u00FA', ucirc: '\u00FB', uuml: '\u00FC', yacute: '\u00FD', thorn: '\u00FE', yuml: '\u00FF',
  OElig: '\u0152', oelig: '\u0153', Scaron: '\u0160', scaron: '\u0161', Yuml: '\u0178',
}

const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g

export function decodeHtmlEntities(str: string): string {
  if (!str.includes('&'))
    return str
  return str.replace(ENTITY_RE, (match, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (dec !== undefined) {
      const cp = Number.parseInt(dec, 10)
      return cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) ? '\uFFFD' : String.fromCodePoint(cp)
    }
    if (hex !== undefined) {
      const cp = Number.parseInt(hex, 16)
      return cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) ? '\uFFFD' : String.fromCodePoint(cp)
    }
    if (named !== undefined && Object.hasOwn(HTML_ENTITIES, named))
      return HTML_ENTITIES[named]!
    return match
  })
}

export function offsetToLineCol(code: string, offset: number): { line: number, col: number } {
  let line = 1
  let col = 1
  const end = Math.min(Math.max(0, offset), code.length)
  for (let i = 0; i < end; i++) {
    if (code.charCodeAt(i) === 10) {
      line++
      col = 1
    }
    else {
      col++
    }
  }
  return { line, col }
}

export function formatLoc(filename: string, code: string, offset?: number): string {
  if (offset === undefined || offset < 0)
    return filename
  const { line, col } = offsetToLineCol(code, offset)
  return `${filename}:${line}:${col}`
}

/** Renders a short source code frame around `offset` with 1 context line before/after and a caret underline. */
export function formatCodeFrame(code: string, offset: number, endOffset?: number): string {
  if (code.length === 0)
    return ''
  const clamped = Math.min(Math.max(0, offset), code.length)
  const { line, col } = offsetToLineCol(code, clamped)
  const lines = code.split(/\r?\n/)
  const lineIdx = Math.min(line - 1, lines.length - 1)
  const startIdx = Math.max(0, lineIdx - 1)
  const endIdx = Math.min(lines.length - 1, lineIdx + 1)
  const gutterWidth = String(endIdx + 1).length
  const pad = (n: number | '') => String(n).padStart(gutterWidth, ' ')
  const targetLine = lines[lineIdx] ?? ''
  const maxSpan = Math.max(1, targetLine.length - (col - 1))
  const rawSpan = endOffset !== undefined && endOffset > clamped ? endOffset - clamped : 1
  const caretLen = Math.max(1, Math.min(rawSpan, maxSpan))
  const out: string[] = []
  for (let i = startIdx; i <= endIdx; i++) {
    const text = lines[i] ?? ''
    out.push(`  ${pad(i + 1)} | ${text}`)
    if (i === lineIdx)
      out.push(`  ${pad('')} | ${' '.repeat(Math.max(0, col - 1))}${'^'.repeat(caretLen)}`)
  }
  return out.join('\n')
}

export const DIAGNOSTIC_PREFIX_RE = /^.+:\d+:\d+:\s+(?:error|warning):/

export function formatDiagnostic(loc: string, message: string, severity: 'error' | 'warning' = 'error'): string {
  return `${loc}: ${severity}: ${message}`
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

/** Whether JSX appears anywhere inside `node`, itself included. Uses O(1) lookup when precomputed `jsxNodes` is passed. */
export function containsJsx(node: Node | null | undefined, jsxNodes?: WeakSet<Node>): boolean {
  if (node === null || node === undefined)
    return false
  if (jsxNodes !== undefined)
    return jsxNodes.has(node)
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
export function blockReturnsJsx(block: BlockStatement, jsxNodes?: WeakSet<Node>): boolean {
  if (jsxNodes !== undefined && !jsxNodes.has(block))
    return false
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
    if (child.type === 'ReturnStatement' && child.argument !== null && containsJsx(child.argument, jsxNodes)) {
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
export function matchJsxMapCall(expr: Node, jsxNodes?: WeakSet<Node>): MapCallMatch | undefined {
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
  if (body.type === 'BlockStatement' && blockReturnsJsx(body, jsxNodes))
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
export function classifyJsxChild(child: JSXChild, jsxNodes?: WeakSet<Node>): ChildSlotKind | undefined {
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
    const mapMatch = matchJsxMapCall(expr, jsxNodes)
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
export function isNodeCapableExpr(expr: Expression, jsxNodes?: WeakSet<Node>): boolean {
  const isChildrenExpr = (expr.type === 'Identifier' && expr.name === 'children')
    || (expr.type === 'MemberExpression' && !expr.computed && expr.property.type === 'Identifier' && expr.property.name === 'children')
  return isChildrenExpr || containsJsx(expr, jsxNodes) || mayReturnNode(expr)
}

export type { Program }

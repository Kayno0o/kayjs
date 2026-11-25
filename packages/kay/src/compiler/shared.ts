// Helpers the dom and ssr compilers share: JSX tag and attribute classification, static escaping, URL and ARIA rules.

import type { AstNode } from './analyze'
import { walk } from './analyze'

export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href'])
const UNSAFE_URL_RE = /^(?:javascript|vbscript):/i
const STRING_BOOL_ATTRS = new Set(['draggable', 'spellcheck', 'contenteditable'])
const CONTROL_RUN_RE = /[\u0000- ]+/g
const LINE_BREAK_RE = /\r\n|\n|\r/

/** ARIA and enumerated attributes render a boolean as the string "true" or "false". */
export function isStringBoolAttr(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('aria-') || STRING_BOOL_ATTRS.has(lower)
}

export function isUnsafeUrlAttr(name: string, value: unknown): boolean {
  if (!URL_ATTRS.has(name.toLowerCase()))
    return false
  return UNSAFE_URL_RE.test(String(value).replace(CONTROL_RUN_RE, ''))
}

export function escapeStaticText(str: string): string {
  return str.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function escapeStaticAttr(str: string): string {
  return escapeStaticText(str).replaceAll('"', '&quot;')
}

export function cleanJsxText(raw: string): string {
  if (!raw.includes('\n'))
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

export function jsxTagName(node: AstNode): string {
  if (node.type === 'JSXIdentifier')
    return node.name as string
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

export function unwrapParens(node: AstNode): AstNode {
  let cur = node
  while (cur.type === 'ParenthesizedExpression')
    cur = cur.expression as AstNode
  return cur
}

/** Refuses React's `innerHTML={{ __html: x }}`: kay takes the string itself and would print `[object Object]`. */
export function assertInnerHtmlNotReactObject(expr: AstNode, filename: string, code: string): void {
  const n = unwrapParens(expr)
  if (n.type !== 'ObjectExpression')
    return
  const prop = (n.properties as AstNode[]).find(p => p.type === 'Property' && (p.key?.name ?? p.key?.value) === '__html')
  if (prop === undefined)
    return
  const value = code.slice(prop.value.start, prop.value.end)
  throw new Error(`kay compiler: innerHTML takes the HTML string in ${filename}: write innerHTML={${value}}, not React's innerHTML={{ __html: ${value} }}.`)
}

export function staticLiteral(node: AstNode): { ok: true, value: string | number | boolean | null } | { ok: false } {
  const n = unwrapParens(node)
  if (n.type === 'Literal') {
    const v = n.value
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)
      return { ok: true, value: v }
  }
  if (n.type === 'UnaryExpression' && n.operator === '-' && n.argument?.type === 'Literal' && typeof n.argument.value === 'number')
    return { ok: true, value: -n.argument.value }
  return { ok: false }
}

export function isJsxNode(node: AstNode | null | undefined): boolean {
  return node?.type === 'JSXElement' || node?.type === 'JSXFragment'
}

/** Whether JSX appears anywhere inside `node`, itself included. */
export function containsJsx(node: AstNode | null | undefined): boolean {
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

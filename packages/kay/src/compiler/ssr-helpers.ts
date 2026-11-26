// Helper utilities for the SSR compiler: string buffer builder, static attribute folding, component prop serialization, and `<select>`/`<option>` helpers.

import type { JSXAttributeItem, JSXChild, JSXElement, Node, Program } from 'oxc-parser'
import { visitorKeys } from 'oxc-parser'
import { URL_ATTRS } from '../attrs'
import { styleText } from '../style'
import {
  cleanJsxText,
  decodeHtmlEntities,
  escapeStaticAttr,
  EVENT_ATTR,
  filterMeaningfulChildren,
  isBlockedAttr,
  isComponentTag,
  isStringBoolAttr,
  isUnsafeUrlAttr,
  jsxTagName,
  staticLiteral,
  unwrapTsExpr,
} from './shared'

export interface SsrSubtreeFlags {
  directAwaitNodes: WeakSet<Node>
  dynamicChildNodes: WeakSet<Node>
}

const AWAIT_BIT = 1
const DYNAMIC_BIT = 2

function isFunctionNode(type: string): boolean {
  return type === 'FunctionDeclaration' || type === 'FunctionExpression' || type === 'ArrowFunctionExpression'
}

/** Precomputes direct-await and dynamic-JSX-child subtree membership in a single O(N) bottom-up pass. */
export function precomputeSsrSubtreeFlags(program: Program): SsrSubtreeFlags {
  const directAwaitNodes = new WeakSet<Node>()
  const dynamicChildNodes = new WeakSet<Node>()

  const visit = (node: unknown): number => {
    if (node === null || typeof node !== 'object')
      return 0
    if (Array.isArray(node)) {
      let mask = 0
      for (let i = 0; i < node.length; i++)
        mask |= visit(node[i])
      return mask
    }
    const ast = node as Node
    const type = ast.type
    if (typeof type !== 'string')
      return 0

    let mask = 0
    if (type === 'AwaitExpression') {
      mask |= AWAIT_BIT
    }
    else if (
      (type === 'JSXExpressionContainer' && ast.expression.type !== 'JSXEmptyExpression')
      || (type === 'JSXElement' && isComponentTag(jsxTagName(ast.openingElement.name)))
    ) {
      mask |= DYNAMIC_BIT
    }

    const keys = visitorKeys[type]
    const rec = ast as unknown as Record<string, unknown>
    if (keys !== undefined) {
      for (let i = 0; i < keys.length; i++)
        mask |= visit(rec[keys[i]!])
    }
    else {
      for (const [k, v] of Object.entries(rec)) {
        if (k !== 'start' && k !== 'end' && k !== 'type')
          mask |= visit(v)
      }
    }

    if ((mask & AWAIT_BIT) !== 0)
      directAwaitNodes.add(ast)
    if ((mask & DYNAMIC_BIT) !== 0)
      dynamicChildNodes.add(ast)
    return isFunctionNode(type) ? (mask & ~AWAIT_BIT) : mask
  }

  visit(program)
  return { directAwaitNodes, dynamicChildNodes }
}

export class StringParts {
  #parts: { static: boolean, value: string }[] = []

  pushStatic(str: string): void {
    if (str === '')
      return
    const last = this.#parts[this.#parts.length - 1]
    if (last !== undefined && last.static)
      last.value += str
    else
      this.#parts.push({ static: true, value: str })
  }

  pushExpr(code: string): void {
    this.#parts.push({ static: false, value: code })
  }

  isEmpty(): boolean {
    return this.#parts.length === 0
  }

  clear(): void {
    this.#parts.length = 0
  }

  toExpr(): string {
    if (this.#parts.length === 0)
      return '""'
    return this.#parts
      .map(p => (p.static ? JSON.stringify(p.value) : `(${p.value})`))
      .join(' + ')
  }
}

function isStaticNullish(node: Node): boolean {
  return (node.type === 'Identifier' && node.name === 'undefined')
    || (node.type === 'Literal' && node.value === null)
}

export function staticLiteralOrTemplate(node: Node): { ok: true, value: string | number | boolean | null } | { ok: false } {
  const n = unwrapTsExpr(node)
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0 && n.quasis.length === 1) {
    const cooked = n.quasis[0]?.value.cooked
    if (typeof cooked === 'string')
      return { ok: true, value: cooked }
  }
  return staticLiteral(n)
}

export function formatStaticAttrValue(name: string, value: string | number | boolean | null, tag?: string): string {
  if (value === null || isBlockedAttr(name))
    return ''
  if (typeof value === 'boolean') {
    if (isStringBoolAttr(name))
      return ` ${name}="${value ? 'true' : 'false'}"`
    return value ? ` ${name}` : ''
  }
  if (isUnsafeUrlAttr(name, value, tag)) {
    if (process.env.NODE_ENV !== 'production')
      console.warn(`kay: dropped unsafe URL on <${tag ?? 'element'} ${name}>.`)
    return ''
  }
  return ` ${name}="${escapeStaticAttr(String(value))}"`
}

export function staticStyleObject(node: Node): Record<string, string | number | boolean | null> | undefined {
  const n = unwrapTsExpr(node)
  if (n.type !== 'ObjectExpression')
    return undefined
  const obj: Record<string, string | number | boolean | null> = {}
  for (const prop of n.properties) {
    if (prop.type !== 'Property' || prop.kind !== 'init' || prop.computed)
      return undefined
    let key: string
    if (prop.key.type === 'Identifier')
      key = prop.key.name
    else if (prop.key.type === 'Literal' && (typeof prop.key.value === 'string' || typeof prop.key.value === 'number'))
      key = String(prop.key.value)
    else
      return undefined
    if (key === '__proto__')
      return undefined
    const lit = staticLiteralOrTemplate(prop.value)
    if (!lit.ok)
      return undefined
    obj[key] = lit.value
  }
  return obj
}

export function formatStaticStyleExpr(expr: Node): string | undefined {
  const unwrapped = unwrapTsExpr(expr)
  const lit = staticLiteralOrTemplate(unwrapped)
  if (lit.ok)
    return typeof lit.value === 'string' ? ` style="${escapeStaticAttr(lit.value)}"` : ''
  if (isStaticNullish(unwrapped))
    return ''
  const obj = staticStyleObject(unwrapped)
  if (obj !== undefined) {
    const css = styleText(obj)
    return css === '' ? '' : ` style="${escapeStaticAttr(css)}"`
  }
  return undefined
}

export function formatStaticAttrBranch(attrName: string, node: Node, tag?: string): string | undefined {
  if (isBlockedAttr(attrName))
    return '""'
  const unwrapped = unwrapTsExpr(node)
  if (isStaticNullish(unwrapped))
    return '""'
  const lit = staticLiteralOrTemplate(unwrapped)
  if (lit.ok)
    return JSON.stringify(formatStaticAttrValue(attrName, lit.value, tag))
  return undefined
}

export function serializeComponentProps(
  attrs: readonly JSXAttributeItem[],
  compileSubExpression: (node: Node) => string,
): {
  propEntries: string[]
  allStaticProps: boolean
  staticPropsObj: Record<string, unknown>
  hydrateExpr: string | undefined
  staticHydrate: string | undefined
} {
  const propEntries: string[] = []
  let allStaticProps = true
  const staticPropsObj: Record<string, unknown> = {}
  let hydrateExpr: string | undefined
  let staticHydrate: string | undefined

  for (const attr of attrs) {
    if (attr.type === 'JSXSpreadAttribute') {
      allStaticProps = false
      propEntries.push(`...(${compileSubExpression(attr.argument)})`)
      continue
    }
    const name = jsxTagName(attr.name)
    if (name === 'key')
      continue
    if (name === '$hydrate') {
      if (attr.value?.type === 'Literal' && typeof attr.value.value === 'string') {
        staticHydrate = attr.value.value
        hydrateExpr = JSON.stringify(attr.value.value)
      }
      else if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
        hydrateExpr = compileSubExpression(attr.value.expression)
      }
      continue
    }

    const propKey = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
    if (attr.value === null) {
      propEntries.push(`${propKey}: true`)
      staticPropsObj[name] = true
    }
    else if (attr.value.type === 'Literal') {
      propEntries.push(`${propKey}: ${JSON.stringify(attr.value.value)}`)
      staticPropsObj[name] = attr.value.value
    }
    else if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
      const expr = attr.value.expression
      const lit = staticLiteral(expr)
      if (lit.ok)
        staticPropsObj[name] = lit.value
      else
        allStaticProps = false
      propEntries.push(`${propKey}: ${compileSubExpression(expr)}`)
    }
  }

  return { propEntries, allStaticProps, staticPropsObj, hydrateExpr, staticHydrate }
}

export interface SelectValueBinding {
  staticValue?: string | undefined
  expr?: string | undefined
  multiple: boolean
}

export function isSimpleValueExpr(node: Node): boolean {
  if (node.type === 'Identifier' || node.type === 'Literal')
    return true
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier')
    return isSimpleValueExpr(node.object)
  return false
}

/** Extracts the static text value of an `<option>` when it has no explicit `value` attribute. */
export function staticOptionText(children: readonly JSXChild[]): string | undefined {
  const meaningful = filterMeaningfulChildren(children)
  if (meaningful.length === 0)
    return ''
  let out = ''
  for (const c of meaningful) {
    if (c.type === 'JSXText')
      out += decodeHtmlEntities(cleanJsxText(c.value))
    else if (c.type === 'JSXExpressionContainer' && c.expression.type === 'Literal' && (typeof c.expression.value === 'string' || typeof c.expression.value === 'number'))
      out += String(c.expression.value)
    else
      return undefined
  }
  return out
}

export function formatOptionSelectedExpr(
  selectVal: SelectValueBinding,
  optVal: { staticValue?: string | undefined, expr?: string | undefined },
): { staticSelected?: boolean | undefined, expr?: string | undefined } {
  if (selectVal.staticValue !== undefined && optVal.staticValue !== undefined)
    return { staticSelected: selectVal.staticValue === optVal.staticValue }
  const sv = selectVal.staticValue !== undefined ? JSON.stringify(selectVal.staticValue) : selectVal.expr!
  const ov = optVal.staticValue !== undefined ? JSON.stringify(optVal.staticValue) : optVal.expr!
  if (selectVal.multiple) {
    const cond = optVal.staticValue !== undefined
      ? `Array.isArray(${sv}) ? ${sv}.some((_x) => String(_x) === ${ov}) : (${sv} != null && String(${sv}) === ${ov})`
      : `${ov} != null && (Array.isArray(${sv}) ? ${sv}.some((_x) => String(_x) === String(${ov})) : (${sv} != null && String(${sv}) === String(${ov})))`
    return { expr: `((${cond}) ? " selected" : "")` }
  }
  const cond = optVal.staticValue !== undefined
    ? `${sv} != null && String(${sv}) === ${ov}`
    : `${sv} != null && ${ov} != null && String(${sv}) === String(${ov})`
  return { expr: `((${cond}) ? " selected" : "")` }
}

export interface SsrElementAttrsContext {
  node: JSXElement
  tag: string
  parts: StringParts
  activeSelectValue: SelectValueBinding | undefined
  flushParts: () => void
  pushStmt: (stmt: string) => void
  nextId: () => number
  use: (name: string) => string
  compileSubExpression: (node: Node) => string
}

export interface SsrElementAttrsResult {
  innerHtmlExpr: string | undefined
  textareaValue: { staticText?: string | undefined, expr?: string | undefined } | undefined
  nextSelectValue: SelectValueBinding | undefined
}

function emitSsrExprAttr(
  ctx: SsrElementAttrsContext,
  name: string,
  expr: Node,
  isOption: boolean,
): { staticValue?: string | undefined, expr?: string | undefined } | undefined {
  const { tag, parts, activeSelectValue, flushParts, pushStmt, nextId, use, compileSubExpression } = ctx

  if (name === 'style') {
    const staticStyle = formatStaticStyleExpr(expr)
    if (staticStyle !== undefined)
      parts.pushStatic(staticStyle)
    else
      parts.pushExpr(`${use('ssrStyle')}(${compileSubExpression(expr)})`)
    return undefined
  }

  const unwrapped = unwrapTsExpr(expr)
  const lit = staticLiteralOrTemplate(unwrapped)
  if (lit.ok) {
    parts.pushStatic(formatStaticAttrValue(name, lit.value, tag))
    if (isOption && name === 'value' && (typeof lit.value === 'string' || typeof lit.value === 'number'))
      return { staticValue: String(lit.value) }
    return undefined
  }
  if (isStaticNullish(unwrapped))
    return undefined

  if (isOption && name === 'value' && activeSelectValue !== undefined) {
    const exprCode = compileSubExpression(expr)
    if (isSimpleValueExpr(expr)) {
      parts.pushExpr(`${use('ssrAttr')}("value", ${exprCode})`)
      return { expr: exprCode }
    }
    const ovVar = `_ov${nextId()}`
    flushParts()
    pushStmt(`const ${ovVar} = ${exprCode};`)
    parts.pushExpr(`${use('ssrAttr')}("value", ${ovVar})`)
    return { expr: ovVar }
  }

  if (expr.type === 'ConditionalExpression') {
    const cons = formatStaticAttrBranch(name, expr.consequent, tag)
    const alt = formatStaticAttrBranch(name, expr.alternate, tag)
    if (cons !== undefined && alt !== undefined) {
      parts.pushExpr(`${compileSubExpression(expr.test)} ? ${cons} : ${alt}`)
      return undefined
    }
  }

  const exprCode = compileSubExpression(expr)
  if (URL_ATTRS.has(name.toLowerCase()))
    parts.pushExpr(`${use('ssrAttr')}(${JSON.stringify(name)}, ${exprCode}, ${JSON.stringify(tag)})`)
  else
    parts.pushExpr(`${use('ssrAttr')}(${JSON.stringify(name)}, ${exprCode})`)
  return undefined
}

/** Emits an HTML/SVG element's SSR opening attributes, handling spreads, `<textarea value>`, and `<select value>`/`<option>`. */
export function emitSsrElementAttrs(ctx: SsrElementAttrsContext): SsrElementAttrsResult {
  const { node, tag, parts, activeSelectValue, flushParts, pushStmt, nextId, use, compileSubExpression } = ctx
  const attrs = node.openingElement.attributes
  const hasSpread = attrs.some(a => a.type === 'JSXSpreadAttribute')
  const isTextarea = tag === 'textarea'
  const isSelect = tag === 'select'
  const isOption = tag === 'option'
  let innerHtmlExpr: string | undefined
  let textareaValue: { staticText?: string | undefined, expr?: string | undefined } | undefined
  let nextSelectValue: SelectValueBinding | undefined
  let optionValue: { staticValue?: string | undefined, expr?: string | undefined } | undefined
  let optionHasExplicitSelected = false
  const selectIsMultiple = isSelect && attrs.some(a => a.type === 'JSXAttribute' && jsxTagName(a.name) === 'multiple')
  const spreadEntries: string[] = []

  for (const attr of attrs) {
    if (attr.type === 'JSXSpreadAttribute') {
      spreadEntries.push(`...(${compileSubExpression(attr.argument)})`)
      continue
    }
    const rawName = jsxTagName(attr.name)
    if (rawName === 'key' || rawName === 'ref' || rawName === '$hydrate' || EVENT_ATTR.test(rawName))
      continue
    if (rawName === 'innerHTML') {
      if (attr.value?.type === 'Literal') {
        innerHtmlExpr = JSON.stringify(String(attr.value.value))
      }
      else if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
        const lit = staticLiteralOrTemplate(attr.value.expression)
        if (lit.ok)
          innerHtmlExpr = lit.value === null || lit.value === false ? '""' : JSON.stringify(String(lit.value))
        else
          innerHtmlExpr = `${use('ssrRaw')}(${compileSubExpression(attr.value.expression)})`
      }
      continue
    }

    const name = rawName === 'className' ? 'class' : rawName === 'htmlFor' ? 'for' : rawName
    if (isBlockedAttr(name))
      continue

    if (isTextarea && name === 'value') {
      if (attr.value?.type === 'Literal') {
        textareaValue = { staticText: String(attr.value.value) }
      }
      else if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
        const lit = staticLiteralOrTemplate(attr.value.expression)
        if (lit.ok)
          textareaValue = { staticText: lit.value === null || typeof lit.value === 'boolean' ? '' : String(lit.value) }
        else
          textareaValue = { expr: compileSubExpression(attr.value.expression) }
      }
      continue
    }

    if (isSelect && name === 'value') {
      if (attr.value?.type === 'Literal') {
        nextSelectValue = { staticValue: String(attr.value.value), multiple: selectIsMultiple }
      }
      else if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
        const lit = staticLiteralOrTemplate(attr.value.expression)
        if (lit.ok) {
          if (lit.value !== null)
            nextSelectValue = { staticValue: String(lit.value), multiple: selectIsMultiple }
        }
        else {
          const svVar = `_sv${nextId()}`
          flushParts()
          pushStmt(`const ${svVar} = ${compileSubExpression(attr.value.expression)};`)
          nextSelectValue = { expr: svVar, multiple: selectIsMultiple }
        }
      }
      continue
    }

    if (isOption && name === 'selected')
      optionHasExplicitSelected = true

    if (hasSpread) {
      const propKey = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
      if (attr.value === null) {
        spreadEntries.push(`${propKey}: true`)
      }
      else if (attr.value.type === 'Literal') {
        if (isOption && name === 'value')
          optionValue = { staticValue: String(attr.value.value) }
        spreadEntries.push(`${propKey}: ${JSON.stringify(attr.value.value)}`)
      }
      else if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
        const exprCode = compileSubExpression(attr.value.expression)
        if (isOption && name === 'value' && activeSelectValue !== undefined) {
          if (isSimpleValueExpr(attr.value.expression)) {
            optionValue = { expr: exprCode }
            spreadEntries.push(`${propKey}: ${exprCode}`)
          }
          else {
            const ovVar = `_ov${nextId()}`
            flushParts()
            pushStmt(`const ${ovVar} = ${exprCode};`)
            optionValue = { expr: ovVar }
            spreadEntries.push(`${propKey}: ${ovVar}`)
          }
        }
        else {
          spreadEntries.push(`${propKey}: ${exprCode}`)
        }
      }
      continue
    }

    if (attr.value === null) {
      parts.pushStatic(isStringBoolAttr(name) ? ` ${name}="true"` : ` ${name}`)
    }
    else if (attr.value.type === 'Literal') {
      if (isOption && name === 'value')
        optionValue = { staticValue: String(attr.value.value) }
      parts.pushStatic(formatStaticAttrValue(name, String(attr.value.value), tag))
    }
    else if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
      const opt = emitSsrExprAttr(ctx, name, attr.value.expression, isOption)
      if (opt !== undefined)
        optionValue = opt
    }
  }

  if (hasSpread) {
    if (spreadEntries.length === 1 && attrs.length === 1) {
      const spreadAttr = attrs[0] as Extract<typeof attrs[number], { type: 'JSXSpreadAttribute' }>
      parts.pushExpr(`${use('ssrSpread')}(${compileSubExpression(spreadAttr.argument)}, ${JSON.stringify(tag)})`)
    }
    else if (spreadEntries.length > 0) {
      parts.pushExpr(`${use('ssrSpread')}({ ${spreadEntries.join(', ')} }, ${JSON.stringify(tag)})`)
    }
  }

  if (isOption && activeSelectValue !== undefined && !optionHasExplicitSelected) {
    if (optionValue === undefined) {
      const textVal = staticOptionText(node.children)
      if (textVal !== undefined) {
        optionValue = { staticValue: textVal }
      }
      else {
        const meaningful = filterMeaningfulChildren(node.children)
        if (
          meaningful.length === 1
          && meaningful[0]!.type === 'JSXExpressionContainer'
          && meaningful[0]!.expression.type !== 'JSXEmptyExpression'
          && isSimpleValueExpr(meaningful[0]!.expression)
        ) {
          optionValue = { expr: compileSubExpression(meaningful[0]!.expression) }
        }
      }
    }
    if (optionValue !== undefined) {
      const sel = formatOptionSelectedExpr(activeSelectValue, optionValue)
      if (sel.staticSelected === true)
        parts.pushStatic(' selected')
      else if (sel.expr !== undefined)
        parts.pushExpr(sel.expr)
    }
  }

  return { innerHtmlExpr, textareaValue, nextSelectValue }
}

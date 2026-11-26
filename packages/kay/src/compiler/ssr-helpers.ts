// Helper utilities for the SSR compiler: string buffer builder, static attribute folding, component prop serialization, and `<select>`/`<option>` helpers.

import type { JSXAttributeItem, JSXChild, JSXElement, Node } from 'oxc-parser'
import { URL_ATTRS } from '../attrs'
import { walk } from './ast'
import {
  cleanJsxText,
  decodeHtmlEntities,
  escapeStaticAttr,
  EVENT_ATTR,
  filterMeaningfulChildren,
  isBlockedAttr,
  isStringBoolAttr,
  isUnsafeUrlAttr,
  jsxTagName,
  staticLiteral,
} from './shared'

export function containsDirectAwait(root: Node): boolean {
  let found = false
  walk(root, (child) => {
    if (found)
      return false
    if (child !== root && (
      child.type === 'FunctionDeclaration'
      || child.type === 'FunctionExpression'
      || child.type === 'ArrowFunctionExpression'
    )) {
      return false
    }
    if (child.type === 'AwaitExpression') {
      found = true
      return false
    }
    return undefined
  })
  return found
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

export function formatStaticAttrBranch(attrName: string, node: Node, tag?: string): string | undefined {
  if (isBlockedAttr(attrName))
    return '""'
  if (isStaticNullish(node))
    return '""'
  if (node.type === 'Literal') {
    if (typeof node.value === 'boolean') {
      if (isStringBoolAttr(attrName))
        return JSON.stringify(` ${attrName}="${node.value ? 'true' : 'false'}"`)
      return node.value ? JSON.stringify(` ${attrName}`) : '""'
    }
    if (typeof node.value === 'string' || typeof node.value === 'number') {
      if (isUnsafeUrlAttr(attrName, node.value, tag)) {
        if (process.env.NODE_ENV !== 'production')
          console.warn(`kay: dropped unsafe URL on <${tag ?? 'element'} ${attrName}>.`)
        return '""'
      }
      return JSON.stringify(` ${attrName}="${escapeStaticAttr(String(node.value))}"`)
    }
  }
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
      if (attr.value?.type === 'Literal')
        innerHtmlExpr = JSON.stringify(String(attr.value.value))
      else if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression')
        innerHtmlExpr = `${use('ssrRaw')}(${compileSubExpression(attr.value.expression)})`
      continue
    }

    const name = rawName === 'className' ? 'class' : rawName === 'htmlFor' ? 'for' : rawName
    if (isBlockedAttr(name))
      continue

    if (isTextarea && name === 'value') {
      if (attr.value?.type === 'Literal')
        textareaValue = { staticText: String(attr.value.value) }
      else if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression')
        textareaValue = { expr: compileSubExpression(attr.value.expression) }
      continue
    }

    if (isSelect && name === 'value') {
      if (attr.value?.type === 'Literal') {
        nextSelectValue = { staticValue: String(attr.value.value), multiple: selectIsMultiple }
      }
      else if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
        const svVar = `_sv${nextId()}`
        flushParts()
        pushStmt(`const ${svVar} = ${compileSubExpression(attr.value.expression)};`)
        nextSelectValue = { expr: svVar, multiple: selectIsMultiple }
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
      if (!isUnsafeUrlAttr(name, attr.value.value, tag))
        parts.pushStatic(` ${name}="${escapeStaticAttr(String(attr.value.value))}"`)
      else if (process.env.NODE_ENV !== 'production')
        console.warn(`kay: dropped unsafe URL on <${tag} ${name}>.`)
    }
    else if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
      const expr = attr.value.expression

      if (isOption && name === 'value' && activeSelectValue !== undefined) {
        const exprCode = compileSubExpression(expr)
        if (isSimpleValueExpr(expr)) {
          optionValue = { expr: exprCode }
          parts.pushExpr(`${use('ssrAttr')}("value", ${exprCode})`)
        }
        else {
          const ovVar = `_ov${nextId()}`
          flushParts()
          pushStmt(`const ${ovVar} = ${exprCode};`)
          optionValue = { expr: ovVar }
          parts.pushExpr(`${use('ssrAttr')}("value", ${ovVar})`)
        }
        continue
      }

      if (name !== 'style' && expr.type === 'ConditionalExpression') {
        const cons = formatStaticAttrBranch(name, expr.consequent, tag)
        const alt = formatStaticAttrBranch(name, expr.alternate, tag)
        if (cons !== undefined && alt !== undefined) {
          parts.pushExpr(`${compileSubExpression(expr.test)} ? ${cons} : ${alt}`)
          continue
        }
      }

      const exprCode = compileSubExpression(expr)
      if (name === 'style')
        parts.pushExpr(`${use('ssrStyle')}(${exprCode})`)
      else if (URL_ATTRS.has(name.toLowerCase()))
        parts.pushExpr(`${use('ssrAttr')}(${JSON.stringify(name)}, ${exprCode}, ${JSON.stringify(tag)})`)
      else
        parts.pushExpr(`${use('ssrAttr')}(${JSON.stringify(name)}, ${exprCode})`)
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

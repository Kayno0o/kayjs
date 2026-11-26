// Element attribute, event, spread, ref, component callee, and raw-text compilation helpers for the DOM compiler.

import type { JSXElement, Node } from 'oxc-parser'
import { DELEGATED_EVENTS } from './emit'
import { isStaticPropExpr } from './props'
import {
  cleanJsxText,
  DOM_PROPS,
  escapeRawText,
  escapeStaticAttr,
  EVENT_ATTR,
  filterMeaningfulChildren,
  isBlockedAttr,
  isStringBoolAttr,
  isUnsafeUrlAttr,
  jsxTagName,
  staticLiteral,
  unwrapTsExpr,
} from './shared'

const SIMPLE_CALLEE_RE = /^[A-Za-z_$][\w$.]*$/

/** Rewrites a JSX component tag's root identifier through `scopeRewrites` (`<Icon />` -> `__p.Icon`, `<ui.Icon />` -> `__p.ui.Icon`). */
export function resolveComponentCallee(tag: string, scopeRewrites: ReadonlyMap<string, string>): string {
  const dot = tag.indexOf('.')
  const root = dot === -1 ? tag : tag.slice(0, dot)
  const rewritten = scopeRewrites.get(root)
  if (rewritten === undefined)
    return tag
  const safeRoot = SIMPLE_CALLEE_RE.test(rewritten) ? rewritten : `(${rewritten})`
  return dot === -1 ? safeRoot : `${safeRoot}${tag.slice(dot)}`
}

export interface ElementAttrCompileContext {
  el: JSXElement
  tag: string
  elVar: string
  scopeRewrites: ReadonlyMap<string, string>
  ops: string[]
  postChildOps: string[]
  delegatedEvents: Set<string>
  use: (name: string) => string
  freshVar: (prefix?: string) => string
  compileExpression: (node: Node, rewrites: ReadonlyMap<string, string>) => string
}

/** Compiles an HTML/SVG element's attributes, returning the static attribute HTML fragment and pushing DOM ops. */
export function compileElementAttributes(ctx: ElementAttrCompileContext): string {
  const { el, tag, elVar, scopeRewrites, ops, postChildOps, delegatedEvents, use, freshVar, compileExpression } = ctx
  const attrs = el.openingElement.attributes
  const hasSpread = attrs.some(a => a.type === 'JSXSpreadAttribute')
  const isFormValueEl = tag === 'textarea' || tag === 'select'
  const isSelect = tag === 'select'

  if (hasSpread) {
    // Plain object spread inside `spread()`'s reactive effect preserves JSX right-to-left precedence,
    // tracks reactive props/getters, avoids double-binding events, and avoids pulling in `mergeProps`.
    const entries: string[] = []
    let soleSpreadExpr: string | undefined

    for (const attr of attrs) {
      if (attr.type === 'JSXSpreadAttribute') {
        const argCode = compileExpression(attr.argument, scopeRewrites)
        if (attrs.length === 1)
          soleSpreadExpr = argCode
        entries.push(`...(${argCode})`)
        continue
      }
      const rawName = jsxTagName(attr.name)
      if (rawName === 'key' || rawName === '$hydrate')
        continue

      if (rawName === 'innerHTML') {
        if (attr.value?.type === 'Literal')
          ops.push(`${use('setInnerHtml')}(${elVar}, ${JSON.stringify(String(attr.value.value))});`)
        else if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression')
          ops.push(`${use('effect')}(() => ${use('setInnerHtml')}(${elVar}, ${compileExpression(attr.value.expression, scopeRewrites)}));`)
        continue
      }

      const name = rawName === 'className' ? 'class' : rawName === 'htmlFor' ? 'for' : rawName
      const isEvent = EVENT_ATTR.test(rawName)
      if (!isEvent && rawName !== 'ref' && isBlockedAttr(name))
        continue

      const propName = isEvent || rawName === 'ref' ? rawName : name
      const propKey = /^[A-Za-z_$][\w$]*$/.test(propName) ? propName : JSON.stringify(propName)
      if (attr.value === null)
        entries.push(`${propKey}: true`)
      else if (attr.value.type === 'Literal')
        entries.push(`${propKey}: ${JSON.stringify(attr.value.value)}`)
      else if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression')
        entries.push(`${propKey}: ${compileExpression(attr.value.expression, scopeRewrites)}`)
    }

    const targetOps = isSelect ? postChildOps : ops
    if (soleSpreadExpr !== undefined)
      targetOps.push(`${use('spread')}(${elVar}, () => (${soleSpreadExpr}));`)
    else if (entries.length > 0)
      targetOps.push(`${use('spread')}(${elVar}, () => ({ ${entries.join(', ')} }));`)
    return ''
  }

  let html = ''
  for (const attr of attrs) {
    if (attr.type === 'JSXSpreadAttribute')
      continue
    const rawName = jsxTagName(attr.name)
    if (rawName === 'key' || rawName === '$hydrate')
      continue

    if (rawName === 'ref') {
      if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
        const expr = attr.value.expression
        const refCode = compileExpression(expr, scopeRewrites)
        const unwrapped = unwrapTsExpr(expr)
        if (unwrapped.type === 'ArrowFunctionExpression' || unwrapped.type === 'FunctionExpression')
          ops.push(`(${refCode})(${elVar});`)
        else
          ops.push(`(${refCode})?.(${elVar});`)
      }
      continue
    }

    if (rawName === 'innerHTML') {
      if (attr.value?.type === 'Literal')
        ops.push(`${use('setInnerHtml')}(${elVar}, ${JSON.stringify(String(attr.value.value))});`)
      else if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression')
        ops.push(`${use('effect')}(() => ${use('setInnerHtml')}(${elVar}, ${compileExpression(attr.value.expression, scopeRewrites)}));`)
      continue
    }

    const eventMatch = EVENT_ATTR.exec(rawName)
    if (eventMatch !== null) {
      if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
        const expr = attr.value.expression
        const eventName = eventMatch[1]!.toLowerCase()
        const handlerCode = compileExpression(expr, scopeRewrites)
        const isStaticHandler = isStaticPropExpr(expr, scopeRewrites)
        if (DELEGATED_EVENTS.has(eventName)) {
          delegatedEvents.add(eventName)
          if (isStaticHandler)
            ops.push(`${elVar}.$$${eventName} = ${handlerCode};`)
          else
            ops.push(`${use('effect')}(() => { ${elVar}.$$${eventName} = ${handlerCode}; });`)
        }
        else if (isStaticHandler) {
          ops.push(`${use('on')}(${elVar}, ${JSON.stringify(eventName)}, ${handlerCode});`)
        }
        else {
          const hVar = freshVar('_h')
          ops.push(`let ${hVar}; ${use('effect')}(() => { ${hVar} = ${handlerCode}; }); ${use('on')}(${elVar}, ${JSON.stringify(eventName)}, (_ev) => typeof ${hVar} === "function" && ${hVar}(_ev));`)
        }
      }
      continue
    }

    const name = rawName === 'className' ? 'class' : rawName === 'htmlFor' ? 'for' : rawName
    if (isBlockedAttr(name))
      continue

    if (attr.value === null) {
      html += isStringBoolAttr(name) ? ` ${name}="true"` : ` ${name}`
    }
    else if (attr.value.type === 'Literal') {
      // HTML ignores the `value` attribute on `<textarea>` and `<select>`, so set the DOM property instead (and after children for `<select>`).
      if (isFormValueEl && name === 'value') {
        const targetOps = isSelect ? postChildOps : ops
        targetOps.push(`${use('setProp')}(${elVar}, "value", ${JSON.stringify(String(attr.value.value))});`)
      }
      else if (!isUnsafeUrlAttr(name, attr.value.value)) {
        html += ` ${name}="${escapeStaticAttr(String(attr.value.value))}"`
      }
    }
    else if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
      const expr = attr.value.expression
      const lit = !DOM_PROPS.has(name) ? staticLiteral(expr) : { ok: false as const }
      if (lit.ok) {
        if (typeof lit.value === 'boolean') {
          if (isStringBoolAttr(name))
            html += ` ${name}="${lit.value ? 'true' : 'false'}"`
          else if (lit.value === true)
            html += ` ${name}`
        }
        else if (lit.value !== null && !isUnsafeUrlAttr(name, lit.value)) {
          html += ` ${name}="${escapeStaticAttr(String(lit.value))}"`
        }
        continue
      }
      const exprCode = compileExpression(expr, scopeRewrites)
      if (name === 'class') {
        ops.push(`${use('effect')}(() => ${use('setClass')}(${elVar}, ${exprCode}));`)
      }
      else if (name === 'style') {
        ops.push(`${use('effect')}(() => ${use('setStyle')}(${elVar}, ${exprCode}));`)
      }
      else if (DOM_PROPS.has(name)) {
        const targetOps = isSelect && name === 'value' ? postChildOps : ops
        targetOps.push(`${use('effect')}(() => ${use('setProp')}(${elVar}, ${JSON.stringify(name)}, ${exprCode}));`)
      }
      else {
        ops.push(`${use('effect')}(() => ${use('setAttr')}(${elVar}, ${JSON.stringify(name)}, ${exprCode}));`)
      }
    }
  }
  return html
}

/**
 * Compiles `<style>` / `<script>` children without comment markers (HTML parsers treat `<!---->` inside raw text as literal text).
 * Static raw text folds directly into the template; dynamic interpolation updates `el.textContent` directly inside an effect.
 */
export function compileRawTextChildren(
  el: JSXElement,
  rawTextTag: 'style' | 'script',
  elVar: string,
  scopeRewrites: ReadonlyMap<string, string>,
  ops: string[],
  use: (name: string) => string,
  compileExpression: (node: Node, rewrites: ReadonlyMap<string, string>) => string,
): string {
  const meaningful = filterMeaningfulChildren(el.children)
  if (meaningful.length === 0)
    return ''

  const chunks: ({ static: true, text: string } | { static: false, expr: string })[] = []
  let hasDynamic = false

  for (const child of meaningful) {
    if (child.type === 'JSXText') {
      const text = cleanJsxText(child.value)
      if (text !== '')
        chunks.push({ static: true, text })
      continue
    }
    if (child.type === 'JSXExpressionContainer' && child.expression.type !== 'JSXEmptyExpression') {
      const expr = child.expression
      if (expr.type === 'Literal' && typeof expr.value === 'string') {
        if (expr.value !== '')
          chunks.push({ static: true, text: expr.value })
        continue
      }
      if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0 && expr.quasis.length === 1) {
        const cooked = expr.quasis[0]?.value.cooked
        if (typeof cooked === 'string') {
          if (cooked !== '')
            chunks.push({ static: true, text: cooked })
          continue
        }
      }
      hasDynamic = true
      chunks.push({ static: false, expr: compileExpression(expr, scopeRewrites) })
    }
  }

  if (!hasDynamic) {
    let staticHtml = ''
    for (const c of chunks) {
      if (c.static)
        staticHtml += escapeRawText(c.text, rawTextTag)
    }
    return staticHtml
  }

  const parts = chunks.map((c) => {
    if (c.static)
      return JSON.stringify(c.text)
    return `((_v) => _v == null || typeof _v === "boolean" ? "" : String(_v))(${c.expr})`
  })
  const combined = parts.length === 1 ? parts[0]! : parts.join(' + ')
  ops.push(`${use('effect')}(() => { const _s = ${combined}; if (${elVar}.textContent !== _s) ${elVar}.textContent = _s; });`)
  return ''
}

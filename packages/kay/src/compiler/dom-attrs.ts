// Element attribute, event, spread, ref, component callee, and raw-text compilation helpers for the DOM compiler.

import type { JSXElement, Node, Program } from 'oxc-parser'
import { walk } from './ast'
import { DELEGATED_EVENTS } from './emit'
import { isStaticPropExpr } from './props'
import {
  cleanJsxText,
  collectPatternNames,
  DOM_PROPS,
  escapeRawText,
  escapeStaticAttr,
  EVENT_ATTR,
  filterMeaningfulChildren,
  isBlockedAttr,
  isStringBoolAttr,
  isUnsafeUrlAttr,
  jsxTagName,
  unwrapTsExpr,
} from './shared'
import { formatStaticAttrValue, formatStaticStyleExpr, staticLiteralOrTemplate } from './ssr-helpers'

const SIMPLE_CALLEE_RE = /^[A-Za-z_$][\w$.]*$/

function isPlainInitObject(node: Node): boolean {
  const cur = unwrapTsExpr(node)
  if (cur.type !== 'ObjectExpression')
    return false
  for (const prop of cur.properties) {
    if (prop.type !== 'Property' || prop.kind !== 'init')
      return false
  }
  return true
}

/** Names provably never holding a reactive `store()` proxy (local plain-object `const`s or known primitives). */
export function collectStaticStyleNames(program: Program, primitiveVars: ReadonlySet<string>): Set<string> {
  const safe = new Set<string>(primitiveVars)
  const unsafe = new Set<string>()
  const mark = (pat: Node | null | undefined): void => {
    if (pat != null)
      collectPatternNames(pat, unsafe)
  }
  walk(program, (n) => {
    if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations) {
        if (n.kind === 'const' && d.id.type === 'Identifier' && d.init !== null && isPlainInitObject(d.init))
          safe.add(d.id.name)
        else if (n.kind !== 'const' || d.id.type !== 'Identifier' || !primitiveVars.has(d.id.name))
          mark(d.id)
      }
      return
    }
    if (n.type === 'ImportSpecifier' || n.type === 'ImportDefaultSpecifier' || n.type === 'ImportNamespaceSpecifier')
      mark(n.local)
    else if (n.type === 'CatchClause')
      mark(n.param)
    else if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration')
      mark(n.id)
    if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
      for (const p of n.params)
        mark(p)
    }
  })
  for (const name of unsafe)
    safe.delete(name)
  return safe
}

/** True when a DOM expression cannot subscribe to any signal, prop getter, or reactive store, so `__effect()` can be omitted. */
export function isStaticDomExpr(
  rawNode: Node,
  scopeRewrites: ReadonlyMap<string, string>,
  isStyle = false,
  staticStyleNames?: ReadonlySet<string>,
): boolean {
  if (!isStaticPropExpr(rawNode, scopeRewrites))
    return false
  if (!isStyle)
    return true
  const node = unwrapTsExpr(rawNode)
  if (node.type === 'Identifier')
    return staticStyleNames?.has(node.name) === true
  return true
}

function wrapDomOp(stmt: string, isStatic: boolean, use: (name: string) => string): string {
  return isStatic ? `${stmt};` : `${use('effect')}(() => ${stmt});`
}

export function formatSetTextOp(
  targetVar: string,
  exprCode: string,
  expr: Node,
  scopeRewrites: ReadonlyMap<string, string>,
  use: (name: string) => string,
): string {
  return wrapDomOp(`${use('setText')}(${targetVar}, ${exprCode})`, isStaticDomExpr(expr, scopeRewrites), use)
}

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
  staticStyleNames?: ReadonlySet<string> | undefined
  ops: string[]
  postChildOps: string[]
  delegatedEvents: Set<string>
  use: (name: string) => string
  freshVar: (prefix?: string) => string
  compileExpression: (node: Node, rewrites: ReadonlyMap<string, string>) => string
}

function emitDomExprAttr(
  ctx: ElementAttrCompileContext,
  name: string,
  expr: Node,
  isSelect: boolean,
): string {
  const { tag, elVar, scopeRewrites, staticStyleNames, ops, postChildOps, use, compileExpression } = ctx

  if (name === 'style') {
    const staticStyle = formatStaticStyleExpr(expr)
    if (staticStyle !== undefined)
      return staticStyle
    const exprCode = compileExpression(expr, scopeRewrites)
    ops.push(wrapDomOp(`${use('setStyle')}(${elVar}, ${exprCode})`, isStaticDomExpr(expr, scopeRewrites, true, staticStyleNames), use))
    return ''
  }

  if (!DOM_PROPS.has(name)) {
    const unwrapped = unwrapTsExpr(expr)
    const lit = staticLiteralOrTemplate(unwrapped)
    if (lit.ok)
      return formatStaticAttrValue(name, lit.value, tag)
    if (unwrapped.type === 'Identifier' && unwrapped.name === 'undefined' && !scopeRewrites.has('undefined'))
      return ''
  }

  const exprCode = compileExpression(expr, scopeRewrites)
  const isStatic = isStaticDomExpr(expr, scopeRewrites)
  if (name === 'class') {
    ops.push(wrapDomOp(`${use('setClass')}(${elVar}, ${exprCode})`, isStatic, use))
  }
  else if (DOM_PROPS.has(name)) {
    const targetOps = isSelect && name === 'value' ? postChildOps : ops
    targetOps.push(wrapDomOp(`${use('setProp')}(${elVar}, ${JSON.stringify(name)}, ${exprCode})`, isStatic, use))
  }
  else {
    ops.push(wrapDomOp(`${use('setAttr')}(${elVar}, ${JSON.stringify(name)}, ${exprCode})`, isStatic, use))
  }
  return ''
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
        if (attr.value?.type === 'Literal') {
          ops.push(`${use('setInnerHtml')}(${elVar}, ${JSON.stringify(String(attr.value.value))});`)
        }
        else if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
          const expr = attr.value.expression
          ops.push(wrapDomOp(`${use('setInnerHtml')}(${elVar}, ${compileExpression(expr, scopeRewrites)})`, isStaticDomExpr(expr, scopeRewrites), use))
        }
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
      if (attr.value?.type === 'Literal') {
        ops.push(`${use('setInnerHtml')}(${elVar}, ${JSON.stringify(String(attr.value.value))});`)
      }
      else if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
        const expr = attr.value.expression
        ops.push(wrapDomOp(`${use('setInnerHtml')}(${elVar}, ${compileExpression(expr, scopeRewrites)})`, isStaticDomExpr(expr, scopeRewrites), use))
      }
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
      else if (!isUnsafeUrlAttr(name, attr.value.value, tag)) {
        html += ` ${name}="${escapeStaticAttr(String(attr.value.value))}"`
      }
      else if (process.env.NODE_ENV !== 'production') {
        console.warn(`kay: dropped unsafe URL on <${tag} ${name}>.`)
      }
    }
    else if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
      html += emitDomExprAttr(ctx, name, attr.value.expression, isSelect)
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
  let allStaticExprs = true

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
      if (!isStaticDomExpr(expr, scopeRewrites))
        allStaticExprs = false
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
  const updateBody = `{ const _s = ${combined}; if (${elVar}.textContent !== _s) ${elVar}.textContent = _s; }`
  ops.push(allStaticExprs ? updateBody : `${use('effect')}(() => ${updateBody});`)
  return ''
}

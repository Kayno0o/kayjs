// Shared JSX child classification and hydration marker planner used identically by SSR & DOM compilers.

import type {
  ArrowFunctionExpression,
  BlockStatement,
  CallExpression,
  ConditionalExpression,
  Expression,
  Function as OxcFunction,
  JSXChild,
  JSXElement,
  JSXExpressionContainer,
  JSXFragment,
  LogicalExpression,
  Node,
  ParamPattern,
} from 'oxc-parser'
import type { ExprContext } from './expr-context'
import { isNodeCapableExpr } from './expr-context'
import {
  blockReturnsJsx,
  cleanJsxText,
  filterMeaningfulChildren,
  isComponentTag,
  isJsxNode,
  jsxTagName,
  staticLiteral,
  unwrapParens,
} from './shared'

export type { ExprContext } from './expr-context'
export { createExprContext, isDefinitelyPrimitive, isNodeCapableExpr, mayReturnNode } from './expr-context'

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

export type HydrationMarker = 'none' | 'text-open' | 'text' | 'range-open' | 'range'

export interface PlannedChildSlot {
  child: JSXChild
  slot: ChildSlotKind
  marker: HydrationMarker
  open: string
  close: string
  nodeCapable: boolean
}

export interface PlanChildSlotsOptions {
  jsxNodes?: WeakSet<Node> | undefined
  exprContext?: ExprContext | undefined
  emitMarkers?: boolean | undefined
  inFragment?: boolean | undefined
}

const MARKER_DELIMITERS: Record<HydrationMarker, readonly [open: string, close: string]> = {
  'none': ['', ''],
  'text-open': ['<!---->', ''],
  'text': ['<!---->', '<!---->'],
  'range-open': ['<!--k[-->', ''],
  'range': ['<!--k[-->', '<!--k]-->'],
}

/**
 * Single hydration-marker planner shared by SSR and DOM compilers.
 * Computes each child slot's marker shape once so SSR markup and DOM hydration walks stay in lockstep.
 */
export function planChildSlots(children: readonly JSXChild[], options: PlanChildSlotsOptions = {}): PlannedChildSlot[] {
  const { jsxNodes, exprContext, emitMarkers = true, inFragment = false } = options
  const rawSlots: { child: JSXChild, slot: ChildSlotKind }[] = []
  for (const child of filterMeaningfulChildren(children)) {
    const slot = classifyJsxChild(child, jsxNodes)
    if (slot !== undefined)
      rawSlots.push({ child, slot })
  }

  const hasSiblings = rawSlots.length > 1
  // A fragment may sit inside another range, so its dynamic slots are bracketed even alone and always closed, for the markers to balance (#3596).
  const bracketed = emitMarkers && (hasSiblings || inFragment)
  const planned: PlannedChildSlot[] = []
  let hadVariableRange = false

  for (let i = 0; i < rawSlots.length; i++) {
    const { child, slot } = rawSlots[i]!
    const isLast = i === rawSlots.length - 1
    let marker: HydrationMarker = 'none'
    let nodeCapable = false

    switch (slot.kind) {
      case 'static-text':
      case 'element':
        break
      case 'component':
      case 'fragment':
        if (emitMarkers && hasSiblings)
          marker = !isLast || inFragment ? 'range' : 'range-open'
        hadVariableRange = true
        break
      case 'loop':
        if (emitMarkers && (inFragment || !isLast || hadVariableRange))
          marker = 'range'
        hadVariableRange = true
        break
      case 'and-show':
      case 'ternary-show':
        if (bracketed)
          marker = 'range'
        hadVariableRange = true
        break
      case 'expr':
        nodeCapable = isNodeCapableExpr(slot.expr, jsxNodes, exprContext)
        if (nodeCapable) {
          if (bracketed)
            marker = !isLast || inFragment ? 'range' : 'range-open'
          hadVariableRange = true
        }
        else if (bracketed) {
          marker = !isLast || inFragment ? 'text' : 'text-open'
        }
        break
    }

    const [open, close] = MARKER_DELIMITERS[marker]
    planned.push({ child, slot, marker, open, close, nodeCapable })
  }

  return planned
}

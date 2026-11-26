// File-level primitive/JSX expression analysis shared identically by SSR and DOM compilers for `setText` vs `insert` slot planning.

import type {
  CallExpression,
  Expression,
  Node,
  ObjectPattern,
  ParamPattern,
  Program,
} from 'oxc-parser'
import { walk } from './ast'
import { collectPatternNames, containsJsx, unwrapTsExpr } from './shared'
import { matchJsxMapCall } from './slots'

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

const PRIMITIVE_PROPS = new Set(['length', 'size', 'byteLength'])
const PRIMITIVE_IDENTIFIERS = new Set(['undefined', 'NaN', 'Infinity'])

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

function isPrimitiveTypeNode(node: Node | null | undefined): boolean {
  if (node === null || node === undefined)
    return false
  switch (node.type) {
    case 'TSStringKeyword':
    case 'TSNumberKeyword':
    case 'TSBooleanKeyword':
    case 'TSBigIntKeyword':
    case 'TSSymbolKeyword':
    case 'TSNullKeyword':
    case 'TSUndefinedKeyword':
    case 'TSVoidKeyword':
    case 'TSNeverKeyword':
    case 'TSLiteralType':
    case 'TSTemplateLiteralType':
      return true
    case 'TSParenthesizedType':
      return isPrimitiveTypeNode(node.typeAnnotation)
    case 'TSUnionType':
      return node.types.length > 0 && node.types.every(isPrimitiveTypeNode)
    default:
      return false
  }
}

function isPrimitiveSignalTypeNode(node: Node | null | undefined): boolean {
  if (node === null || node === undefined || node.type !== 'TSTypeReference')
    return false
  const name = node.typeName.type === 'Identifier' ? node.typeName.name : ''
  if (name !== 'Signal' && name !== 'ReadonlySignal')
    return false
  const params = node.typeArguments?.params
  return params !== undefined && params.length === 1 && isPrimitiveTypeNode(params[0])
}

function memberPropKey(node: Node): string | undefined {
  if (node.type === 'Identifier')
    return node.name
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number'))
    return String(node.value)
  return undefined
}

function extractTypeLiteralPrimitives(typeNode: Node | null | undefined): { prims: Set<string>, primSignals: Set<string> } | undefined {
  if (typeNode === null || typeNode === undefined || typeNode.type !== 'TSTypeLiteral')
    return undefined
  const prims = new Set<string>()
  const primSignals = new Set<string>()
  for (const m of typeNode.members) {
    if (m.type !== 'TSPropertySignature' || m.computed || m.typeAnnotation === null || m.typeAnnotation === undefined)
      continue
    const key = memberPropKey(m.key)
    if (key === undefined)
      continue
    if (isPrimitiveTypeNode(m.typeAnnotation.typeAnnotation))
      prims.add(key)
    else if (isPrimitiveSignalTypeNode(m.typeAnnotation.typeAnnotation))
      primSignals.add(key)
  }
  return { prims, primSignals }
}

function rootIdentifierName(node: Node): string | undefined {
  let cur = unwrapTsExpr(node)
  while (cur.type === 'MemberExpression' || cur.type === 'ChainExpression')
    cur = unwrapTsExpr(cur.type === 'ChainExpression' ? cur.expression : cur.object)
  return cur.type === 'Identifier' ? cur.name : undefined
}

export interface ExprContext {
  primitiveVars: ReadonlySet<string>
  primitiveSignals: ReadonlySet<string>
  propsParams: ReadonlySet<string>
  primitivePropKeys: ReadonlyMap<string, ReadonlySet<string>>
  jsxVars: ReadonlySet<string>
}

function isSignalCall(node: Node): { kind: 'signal' | 'computed', call: CallExpression } | undefined {
  const cur = unwrapTsExpr(node)
  if (cur.type !== 'CallExpression')
    return undefined
  const c = cur.callee
  const name = c.type === 'Identifier'
    ? c.name
    : c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier'
      ? c.property.name
      : ''
  if (name === 'signal' || name === 'computed')
    return { kind: name, call: cur }
  return undefined
}

/**
 * File-level static primitive/JSX binding analysis shared identically by SSR and DOM compilers
 * so `planChildSlots` chooses matching `setText` vs `insert` slots and markers on both targets.
 */
export function createExprContext(program: Program, jsxNodes: WeakSet<Node>): ExprContext {
  const primCandidates = new Set<string>()
  const nonPrimNames = new Set<string>()
  const sigCandidates = new Set<string>()
  const nonSigNames = new Set<string>()
  const propsParams = new Set<string>()
  const primitivePropKeys = new Map<string, Set<string>>()
  const jsxVars = new Set<string>()
  const deferredInits: { name: string, init: Node, isSignal: boolean, signalKind?: 'signal' | 'computed' }[] = []

  const markNonPrim = (pat: Node | null | undefined): void => {
    if (pat === null || pat === undefined)
      return
    collectPatternNames(pat, nonPrimNames)
    collectPatternNames(pat, nonSigNames)
  }

  const recordObjectPatternTypes = (pat: ObjectPattern, typeNode: Node | null | undefined): void => {
    const info = extractTypeLiteralPrimitives(typeNode)
    for (const prop of pat.properties) {
      if (prop.type === 'RestElement') {
        markNonPrim(prop.argument)
        continue
      }
      const key = !prop.computed ? memberPropKey(prop.key) : undefined
      const val = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value
      if (val.type === 'Identifier' && key !== undefined && info !== undefined) {
        if (info.prims.has(key)) {
          primCandidates.add(val.name)
          nonSigNames.add(val.name)
          continue
        }
        if (info.primSignals.has(key)) {
          sigCandidates.add(val.name)
          nonPrimNames.add(val.name)
          continue
        }
      }
      markNonPrim(val)
    }
  }

  const recordParam = (param: ParamPattern, isComponentFirstParam: boolean, isMapIndexParam: boolean): void => {
    const inner = param.type === 'AssignmentPattern' ? param.left : param
    if (inner.type === 'ObjectPattern') {
      recordObjectPatternTypes(inner, inner.typeAnnotation?.typeAnnotation)
      return
    }
    if (inner.type === 'Identifier') {
      const ann = inner.typeAnnotation?.typeAnnotation
      if (isMapIndexParam || isPrimitiveTypeNode(ann)) {
        primCandidates.add(inner.name)
        nonSigNames.add(inner.name)
        return
      }
      if (isPrimitiveSignalTypeNode(ann)) {
        sigCandidates.add(inner.name)
        nonPrimNames.add(inner.name)
        return
      }
      if (isComponentFirstParam) {
        propsParams.add(inner.name)
        const info = extractTypeLiteralPrimitives(ann)
        if (info !== undefined && !primitivePropKeys.has(inner.name))
          primitivePropKeys.set(inner.name, info.prims)
      }
    }
    markNonPrim(inner)
  }

  const mapCallbacks = new WeakSet<Node>()
  walk(program, (node) => {
    const mapMatch = matchJsxMapCall(node, jsxNodes)
    if (mapMatch !== undefined)
      mapCallbacks.add(mapMatch.cb)
  })

  walk(program, (node) => {
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.init !== null && containsJsx(d.init, jsxNodes))
          collectPatternNames(d.id, jsxVars)
        if (d.id.type === 'Identifier') {
          const ann = d.id.typeAnnotation?.typeAnnotation
          if (isPrimitiveTypeNode(ann)) {
            primCandidates.add(d.id.name)
            nonSigNames.add(d.id.name)
            continue
          }
          if (isPrimitiveSignalTypeNode(ann)) {
            sigCandidates.add(d.id.name)
            nonPrimNames.add(d.id.name)
            continue
          }
          if (node.kind === 'const' && d.init !== null) {
            const sig = isSignalCall(d.init)
            if (sig !== undefined) {
              nonPrimNames.add(d.id.name)
              const tArgs = sig.call.typeArguments?.params
              if (tArgs !== undefined && tArgs.length === 1 && isPrimitiveTypeNode(tArgs[0]))
                sigCandidates.add(d.id.name)
              else
                deferredInits.push({ name: d.id.name, init: sig.call, isSignal: true, signalKind: sig.kind })
              continue
            }
            deferredInits.push({ name: d.id.name, init: d.init, isSignal: false })
            nonSigNames.add(d.id.name)
            continue
          }
        }
        markNonPrim(d.id)
      }
      return
    }
    if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') {
      markNonPrim(node.local)
      return
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration')
      markNonPrim(node.id)
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      const isMapCb = mapCallbacks.has(node)
      const isComponent = !isMapCb && node.body !== null && containsJsx(node.body, jsxNodes)
      for (let i = 0; i < node.params.length; i++)
        recordParam(node.params[i]!, isComponent && i === 0, isMapCb && i === 1)
      return
    }
    if (node.type === 'CatchClause') {
      markNonPrim(node.param)
      return
    }
    if (node.type === 'AssignmentExpression') {
      if (containsJsx(node.right, jsxNodes)) {
        const targetRoot = rootIdentifierName(node.left)
        if (targetRoot !== undefined)
          jsxVars.add(targetRoot)
      }
      if (node.left.type === 'MemberExpression' && !node.left.computed && node.left.object.type === 'Identifier' && node.left.property.type === 'Identifier' && node.left.property.name === 'value') {
        if (!isDefinitelyPrimitive(node.right, undefined))
          nonSigNames.add(node.left.object.name)
      }
      else {
        const names = new Set<string>()
        collectPatternNames(node.left, names)
        for (const n of names) {
          if (!isDefinitelyPrimitive(node.right, undefined))
            nonPrimNames.add(n)
          nonSigNames.add(n)
        }
      }
    }
  })

  for (const n of nonPrimNames)
    primCandidates.delete(n)
  for (const n of nonSigNames)
    sigCandidates.delete(n)

  const ctx: ExprContext = {
    primitiveVars: primCandidates,
    primitiveSignals: sigCandidates,
    propsParams,
    primitivePropKeys,
    jsxVars,
  }

  for (let pass = 0; pass < 2; pass++) {
    for (const item of deferredInits) {
      if (item.isSignal) {
        if (nonSigNames.has(item.name))
          continue
        const call = item.init as CallExpression
        const arg = call.arguments[0]
        if (item.signalKind === 'signal' && arg !== undefined && arg.type !== 'SpreadElement' && isDefinitelyPrimitive(arg, ctx)) {
          sigCandidates.add(item.name)
        }
        else if (item.signalKind === 'computed' && arg !== undefined && (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression')) {
          if (arg.body !== null && arg.body.type !== 'BlockStatement' && isDefinitelyPrimitive(arg.body, ctx))
            sigCandidates.add(item.name)
        }
      }
      else if (!nonPrimNames.has(item.name) && isDefinitelyPrimitive(item.init, ctx)) {
        primCandidates.add(item.name)
      }
    }
  }

  for (const n of nonPrimNames)
    primCandidates.delete(n)
  for (const n of nonSigNames)
    sigCandidates.delete(n)

  return ctx
}

export function isDefinitelyPrimitive(node: Node, ctx?: ExprContext): boolean {
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSTypeAssertion') {
    if (isPrimitiveTypeNode(node.typeAnnotation))
      return true
    return isDefinitelyPrimitive(node.expression, ctx)
  }
  const cur = unwrapTsExpr(node)
  switch (cur.type) {
    case 'Literal':
    case 'TemplateLiteral':
    case 'BinaryExpression':
    case 'UnaryExpression':
    case 'UpdateExpression':
      return true
    case 'Identifier':
      return PRIMITIVE_IDENTIFIERS.has(cur.name) || ctx?.primitiveVars.has(cur.name) === true
    case 'CallExpression':
      return isKnownPrimitiveCall(cur)
    case 'LogicalExpression':
      if (cur.operator === '&&')
        return isDefinitelyPrimitive(cur.right, ctx)
      return isDefinitelyPrimitive(cur.left, ctx) && isDefinitelyPrimitive(cur.right, ctx)
    case 'ConditionalExpression':
      return isDefinitelyPrimitive(cur.consequent, ctx) && isDefinitelyPrimitive(cur.alternate, ctx)
    case 'SequenceExpression':
      return cur.expressions.length > 0 && isDefinitelyPrimitive(cur.expressions[cur.expressions.length - 1]!, ctx)
    case 'ChainExpression':
      return isDefinitelyPrimitive(cur.expression, ctx)
    case 'MemberExpression': {
      if (!cur.computed && cur.property.type === 'Identifier') {
        const prop = cur.property.name
        if (PRIMITIVE_PROPS.has(prop))
          return true
        if (prop === 'children')
          return false
        if (prop === 'value')
          return cur.object.type === 'Identifier' && ctx?.primitiveSignals.has(cur.object.name) === true
        const root = rootIdentifierName(cur.object)
        if (root !== undefined && ctx?.jsxVars.has(root) === true)
          return false
        if (cur.object.type === 'Identifier' && ctx?.propsParams.has(cur.object.name) === true)
          return ctx.primitivePropKeys.get(cur.object.name)?.has(prop) === true
        return true
      }
      return false
    }
    default:
      return false
  }
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
export function isNodeCapableExpr(expr: Expression, jsxNodes?: WeakSet<Node>, exprContext?: ExprContext): boolean {
  if (containsJsx(expr, jsxNodes))
    return true
  return !isDefinitelyPrimitive(expr, exprContext)
}

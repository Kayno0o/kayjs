// Which top-level keys of `props.data` a page island reads, so the server sends only those.

import type { ArrowFunctionExpression, Function as OxcFunction, Node, Program } from 'oxc-parser'
import { visitorKeys } from 'oxc-parser'
import { collectPatternNames, unwrapTsExpr } from './shared'

function staticPropKey(prop: Node): string | undefined {
  if (prop.type !== 'Property')
    return undefined
  if (!prop.computed && prop.key.type === 'Identifier')
    return prop.key.name
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string')
    return prop.key.value
  return undefined
}

function extractObjectPatternKeys(pat: Node): string[] | undefined {
  if (pat.type !== 'ObjectPattern')
    return undefined
  const keys: string[] = []
  for (const prop of pat.properties) {
    if (prop.type === 'RestElement')
      return undefined
    const k = staticPropKey(prop)
    if (k === undefined)
      return undefined
    keys.push(k)
  }
  return keys
}

function memberKeyName(node: Node): string | undefined {
  if (node.type !== 'MemberExpression')
    return undefined
  if (!node.computed && node.property.type === 'Identifier')
    return node.property.name
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string')
    return node.property.value
  return undefined
}

function unwrapParamPattern(param: Node): Node {
  return param.type === 'AssignmentPattern' ? param.left : param
}

function resolveDefaultFunction(
  program: Program,
  defaultLocal: string | undefined,
  localInits: ReadonlyMap<string, Node>,
): OxcFunction | ArrowFunctionExpression | undefined {
  const localFns = new Map<string, OxcFunction>()
  for (const stmt of program.body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id !== null)
      localFns.set(stmt.id.name, stmt)
    else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration?.type === 'FunctionDeclaration' && stmt.declaration.id !== null)
      localFns.set(stmt.declaration.id.name, stmt.declaration)
  }

  const unwrapTarget = (node: Node | undefined, depth = 0): OxcFunction | ArrowFunctionExpression | undefined => {
    if (node === undefined || depth > 4)
      return undefined
    const inner = unwrapTsExpr(node)
    if (inner.type === 'FunctionDeclaration' || inner.type === 'FunctionExpression' || inner.type === 'ArrowFunctionExpression')
      return inner
    if (inner.type === 'Identifier')
      return localFns.get(inner.name) ?? unwrapTarget(localInits.get(inner.name), depth + 1)
    return undefined
  }

  for (const stmt of program.body) {
    if (stmt.type === 'ExportDefaultDeclaration')
      return unwrapTarget(stmt.declaration)
  }
  if (defaultLocal !== undefined)
    return localFns.get(defaultLocal) ?? unwrapTarget(localInits.get(defaultLocal))
  return undefined
}

const TS_EXPR_WRAPPERS = new Set([
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
])

/** Statically bounds which top-level keys of `props.data` a page island reads; returns `undefined` if `data` escapes. */
export function analyzeDefaultDataKeys(
  program: Program,
  defaultLocal: string | undefined,
  localInits: ReadonlyMap<string, Node>,
): string[] | undefined {
  const fn = resolveDefaultFunction(program, defaultLocal, localInits)
  if (fn === undefined || fn.body === null)
    return undefined
  if (fn.params.length === 0)
    return []

  const firstParam = unwrapParamPattern(fn.params[0]!)
  const keys = new Set<string>()
  let escaped = false
  let dataVar: string | undefined
  let propsVar: string | undefined

  if (firstParam.type === 'ObjectPattern') {
    let dataProp: Node | undefined
    for (const prop of firstParam.properties) {
      if (prop.type === 'RestElement')
        return undefined
      const key = staticPropKey(prop)
      // A computed/non-static key in the props pattern might bind `data`, so bail out safely instead of stripping live keys.
      if (key === undefined)
        return undefined
      if (key === 'data')
        dataProp = prop
    }
    if (dataProp === undefined || dataProp.type !== 'Property')
      return []
    const binding = unwrapParamPattern(dataProp.value)
    if (binding.type === 'ObjectPattern') {
      const nested = extractObjectPatternKeys(binding)
      if (nested === undefined)
        return undefined
      return [...new Set(nested)].sort()
    }
    if (binding.type !== 'Identifier')
      return undefined
    dataVar = binding.name
  }
  else if (firstParam.type === 'Identifier') {
    propsVar = firstParam.name
  }
  else {
    return undefined
  }

  // Walk expressions tracking parent chains so every reference to `dataVar` or `propsVar` is verified.
  const ancestors: Node[] = []
  const walkWithParents = (node: unknown): void => {
    if (escaped || node === null || typeof node !== 'object')
      return
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++)
        walkWithParents(node[i])
      return
    }
    const ast = node as Node
    const type = ast.type
    if (typeof type !== 'string')
      return

    if (type.startsWith('TS')) {
      if (TS_EXPR_WRAPPERS.has(type))
        walkWithParents((ast as { expression?: unknown }).expression)
      return
    }

    // Respect inner function parameters (and named FunctionExpression ids) that shadow `dataVar` or `propsVar`,
    // walking parameter defaults before each parameter's bound names enter scope.
    if (ast !== fn && (type === 'FunctionDeclaration' || type === 'FunctionExpression' || type === 'ArrowFunctionExpression')) {
      const innerFn = ast as OxcFunction | ArrowFunctionExpression
      const shadowed = new Set<string>()
      if (innerFn.type !== 'ArrowFunctionExpression' && innerFn.id !== null)
        shadowed.add(innerFn.id.name)
      let isShadowed = (dataVar !== undefined && shadowed.has(dataVar)) || (propsVar !== undefined && shadowed.has(propsVar))
      for (const p of innerFn.params) {
        if (isShadowed)
          return
        walkPatternDefaults(p)
        collectPatternNames(p, shadowed)
        if ((dataVar !== undefined && shadowed.has(dataVar)) || (propsVar !== undefined && shadowed.has(propsVar)))
          isShadowed = true
      }
      if (!isShadowed && innerFn.body !== null)
        walkWithParents(innerFn.body)
      return
    }

    if (type === 'Identifier') {
      const parent = ancestors[ancestors.length - 1]
      const grand = ancestors[ancestors.length - 2]
      const isNonRef = parent !== undefined && (
        (parent.type === 'MemberExpression' && !parent.computed && parent.property === ast)
        || (parent.type === 'Property' && !parent.computed && parent.key === ast && !parent.shorthand)
        || (parent.type === 'VariableDeclarator' && parent.id === ast)
        || (parent.type === 'LabeledStatement' && parent.label === ast)
        || (parent.type === 'FunctionDeclaration' && parent.id === ast)
        || (parent.type === 'FunctionExpression' && parent.id === ast)
      )

      if (!isNonRef && dataVar !== undefined && ast.name === dataVar) {
        if (parent?.type === 'MemberExpression' && parent.object === ast) {
          const k = memberKeyName(parent)
          if (k === undefined)
            escaped = true
          else
            keys.add(k)
        }
        else if (parent?.type === 'VariableDeclarator' && parent.init === ast) {
          const nested = extractObjectPatternKeys(parent.id)
          if (nested === undefined)
            escaped = true
          else
            for (const k of nested) keys.add(k)
        }
        else {
          escaped = true
        }
      }
      else if (!isNonRef && propsVar !== undefined && ast.name === propsVar) {
        if (parent?.type === 'MemberExpression' && parent.object === ast) {
          const propName = memberKeyName(parent)
          if (propName === undefined) {
            escaped = true
          }
          else if (propName === 'data') {
            const holder = grand?.type === 'ChainExpression' ? ancestors[ancestors.length - 3] : grand
            const target = grand?.type === 'ChainExpression' ? grand : parent
            if (holder?.type === 'MemberExpression' && holder.object === target) {
              const k = memberKeyName(holder)
              if (k === undefined)
                escaped = true
              else
                keys.add(k)
            }
            else if (holder?.type === 'VariableDeclarator' && holder.init === target) {
              const nested = extractObjectPatternKeys(holder.id)
              if (nested === undefined)
                escaped = true
              else
                for (const k of nested) keys.add(k)
            }
            else {
              escaped = true
            }
          }
        }
        else {
          escaped = true
        }
      }
    }

    ancestors.push(ast)
    const childKeys = visitorKeys[type]
    if (childKeys !== undefined) {
      const rec = ast as unknown as Record<string, unknown>
      for (let i = 0; i < childKeys.length; i++) {
        const val = rec[childKeys[i]!]
        if (val !== null && typeof val === 'object')
          walkWithParents(val)
      }
    }
    ancestors.pop()
  }

  const walkPatternDefaults = (pattern: Node | null | undefined): void => {
    if (escaped || pattern === null || pattern === undefined)
      return
    switch (pattern.type) {
      case 'AssignmentPattern':
        walkPatternDefaults(pattern.left)
        walkWithParents(pattern.right)
        return
      case 'RestElement':
        walkPatternDefaults(pattern.argument)
        return
      case 'TSParameterProperty':
        walkPatternDefaults(pattern.parameter)
        return
      case 'ArrayPattern':
        for (const el of pattern.elements)
          walkPatternDefaults(el)
        return
      case 'ObjectPattern':
        for (const prop of pattern.properties) {
          if (prop.type === 'RestElement') {
            walkPatternDefaults(prop.argument)
          }
          else {
            if (prop.computed)
              walkWithParents(prop.key)
            walkPatternDefaults(prop.value)
          }
        }
    }
  }

  // Walk outer parameter defaults (e.g. `function Page({ data, title = data.title })`) before the body.
  for (const p of fn.params)
    walkPatternDefaults(p)

  walkWithParents(fn.body)
  return escaped ? undefined : [...keys].sort()
}

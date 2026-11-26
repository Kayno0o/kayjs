// Compiles a component's destructured props: reads stay reactive through `__p`, and the function is rewritten around it.

import type { ArrowFunctionExpression, Function as OxcFunction, Node, ObjectPattern, ParamPattern } from 'oxc-parser'
import { SourceEditor } from './patch'
import { collectPatternNames, containsJsx, unwrapTsExpr } from './shared'

export function withoutBindings(rewrites: ReadonlyMap<string, string>, patterns: readonly Node[]): Map<string, string> {
  const names = new Set<string>()
  for (const pattern of patterns)
    collectPatternNames(pattern, names)
  const kept = new Map(rewrites)
  for (const name of names)
    kept.delete(name)
  return kept
}

/** True when a JSX prop expression is statically stable (non-rewritten identifier, literal, function, or constant array/object) and needs no reactive getter. */
export function isStaticPropExpr(rawNode: Node, scopeRewrites: ReadonlyMap<string, string>): boolean {
  const node = unwrapTsExpr(rawNode)
  switch (node.type) {
    case 'Literal':
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return true
    case 'Identifier':
      return !scopeRewrites.has(node.name)
    case 'UnaryExpression':
      return (node.operator === '-' || node.operator === '+' || node.operator === '!' || node.operator === '~' || node.operator === 'void')
        && isStaticPropExpr(node.argument, scopeRewrites)
    case 'TemplateLiteral':
      return node.expressions.every(e => isStaticPropExpr(e, scopeRewrites))
    case 'ArrayExpression':
      return node.elements.every(el => el === null || (el.type !== 'SpreadElement' && isStaticPropExpr(el, scopeRewrites)))
    case 'ObjectExpression':
      return node.properties.every((prop) => {
        if (prop.type !== 'Property' || prop.kind !== 'init')
          return false
        if (prop.computed && !isStaticPropExpr(prop.key, scopeRewrites))
          return false
        return isStaticPropExpr(prop.value, scopeRewrites)
      })
    default:
      return false
  }
}

export interface DestructuredParam {
  pattern: ObjectPattern
  defaultExpr: Node | undefined
  replaceStart: number
  replaceEnd: number
  typeAnn: string
}

export interface PropCompilerContext {
  code: string
  editor: SourceEditor
  jsxNodes: WeakSet<Node>
  use: (name: string) => string
  freshVar: (prefix?: string) => string
  compileExpression: (node: Node, rewrites: ReadonlyMap<string, string>) => string
}

export interface PropCompiler {
  patternReads: (pattern: Node, source: string, outerRewrites: ReadonlyMap<string, string>) => Map<string, string>
  extractDestructuredParam: (firstParam: ParamPattern | undefined) => DestructuredParam | undefined
  buildCompiledFunction: (fn: ArrowFunctionExpression | OxcFunction, outerRewrites: ReadonlyMap<string, string>) => string
  processFunction: (fn: ArrowFunctionExpression | OxcFunction) => void
}

export function createPropCompiler(ctx: PropCompilerContext): PropCompiler {
  const { code, editor, jsxNodes, use, freshVar, compileExpression } = ctx

  // How each name a destructuring pattern binds is read from `source` on every access, so reads stay reactive.
  // With `hoisted`, a default and a nested pattern's getter become statements for the start of the component body (evaluated once per call) instead of running on every read.
  function patternReads(pattern: Node, source: string, outerRewrites: ReadonlyMap<string, string>, hoisted?: string[]): Map<string, string> {
    const reads = new Map<string, string>()
    const running = new Map(outerRewrites)
    const hoist = (init: string): string => {
      const name = freshVar('__d')
      hoisted!.push(`const ${name} = ${init};`)
      return name
    }
    if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties) {
        if (prop.type !== 'Property' || prop.computed || prop.key.type !== 'Identifier')
          continue
        const read = `${source}.${prop.key.name}`
        if (prop.value.type === 'Identifier') {
          reads.set(prop.value.name, read)
          running.set(prop.value.name, read)
        }
        else if (prop.value.type === 'AssignmentPattern' && prop.value.left.type === 'Identifier') {
          const defExpr = compileExpression(prop.value.right, running)
          const simpleDef = prop.value.right.type === 'Literal' || prop.value.right.type === 'Identifier'
          let fallback = simpleDef ? defExpr : `(${defExpr})`
          if (!simpleDef && hoisted !== undefined)
            fallback = `${hoist(`${use('propDefault')}(() => (${defExpr}), ${read} === undefined)`)}()`
          const expr = `(${read} === undefined ? ${fallback} : ${read})`
          reads.set(prop.value.left.name, expr)
          running.set(prop.value.left.name, expr)
        }
      }
    }
    const names = new Set<string>()
    collectPatternNames(pattern, names)
    // The pattern a read runs: only the property binding `name`, so another property's default does not run on this read.
    const patternFor = (name: string): string => {
      if (pattern.type === 'ObjectPattern') {
        for (const prop of (pattern as ObjectPattern).properties) {
          const bound = new Set<string>()
          collectPatternNames(prop.type === 'RestElement' ? prop.argument : prop.value, bound)
          if (prop.type === 'Property' && bound.has(name))
            return `{ ${code.slice(prop.start, prop.end)} }`
        }
      }
      return code.slice(pattern.start, pattern.end)
    }
    // A component's `...rest` is read through `omit` instead (see computePropRewrites).
    const omitted = hoisted !== undefined && pattern.type === 'ObjectPattern' ? omittedRest(pattern as ObjectPattern) : undefined
    for (const name of names) {
      if (reads.has(name) || name === omitted?.restName)
        continue
      const getter = `(${patternFor(name)}) => ${name}`
      reads.set(name, hoisted === undefined ? `(${getter})(${source})` : `${hoist(getter)}(${source})`)
    }
    return reads
  }

  // The keys a `...rest` leaves out, when every key of the pattern is a plain name or string.
  function omittedRest(pattern: ObjectPattern): { restName: string | undefined, keys: string[] | undefined } {
    const keys: string[] = []
    let restName: string | undefined
    let isStatic = true
    for (const prop of pattern.properties) {
      if (prop.type === 'RestElement')
        restName = prop.argument.type === 'Identifier' ? prop.argument.name : undefined
      else if (!prop.computed && prop.key.type === 'Identifier')
        keys.push(prop.key.name)
      else if (!prop.computed && prop.key.type === 'Literal' && typeof prop.key.value === 'string')
        keys.push(prop.key.value)
      else
        isStatic = false
    }
    return isStatic && restName !== undefined ? { restName, keys } : { restName: undefined, keys: undefined }
  }

  function extractDestructuredParam(firstParam: ParamPattern | undefined): {
    pattern: ObjectPattern
    defaultExpr: Node | undefined
    replaceStart: number
    replaceEnd: number
    typeAnn: string
  } | undefined {
    if (firstParam === undefined)
      return undefined
    if (firstParam.type === 'ObjectPattern') {
      const typeAnn = firstParam.typeAnnotation ? code.slice(firstParam.typeAnnotation.start, firstParam.typeAnnotation.end) : ''
      return { pattern: firstParam, defaultExpr: undefined, replaceStart: firstParam.start, replaceEnd: firstParam.end, typeAnn }
    }
    if (firstParam.type === 'AssignmentPattern' && firstParam.left.type === 'ObjectPattern') {
      const pat = firstParam.left
      const typeAnn = pat.typeAnnotation ? code.slice(pat.typeAnnotation.start, pat.typeAnnotation.end) : ''
      return { pattern: pat, defaultExpr: firstParam.right, replaceStart: firstParam.start, replaceEnd: firstParam.end, typeAnn }
    }
    return undefined
  }

  function computePropRewrites(
    destructured: { pattern: ObjectPattern, defaultExpr: Node | undefined },
    pVar: string,
    outerRewrites: ReadonlyMap<string, string>,
  ): { rewrites: Map<string, string>, prelude: string } {
    const rewrites = new Map(outerRewrites)
    const hoisted: string[] = []
    for (const [name, read] of patternReads(destructured.pattern, pVar, outerRewrites, hoisted))
      rewrites.set(name, read)

    const { restName, keys } = omittedRest(destructured.pattern)
    if (restName !== undefined)
      rewrites.set(restName, `${use('omit')}(${pVar}, ${JSON.stringify(keys)})`)
    return { rewrites, prelude: hoisted.join(' ') }
  }

  // Puts the hoisted default statements at the start of a body, giving an expression body a block to hold them.
  function withPrelude(compiledBody: string, body: Node, prelude: string): string {
    if (prelude === '')
      return compiledBody
    return body.type === 'BlockStatement' ? `{ ${prelude}${compiledBody.slice(1)}` : `{ ${prelude} return (${compiledBody}); }`
  }

  function buildCompiledFunction(fn: ArrowFunctionExpression | OxcFunction, outerRewrites: ReadonlyMap<string, string>): string {
    const fnEditor = new SourceEditor(code.slice(fn.start, fn.end))
    const offset = fn.start
    const destructured = extractDestructuredParam(fn.params[0])
    const pVar = freshVar('__p')
    let propRewrites = new Map(outerRewrites)
    let prelude = ''

    if (destructured !== undefined) {
      const defSuffix = destructured.defaultExpr !== undefined
        ? ` = ${compileExpression(destructured.defaultExpr, outerRewrites)}`
        : ''
      fnEditor.replace(destructured.replaceStart - offset, destructured.replaceEnd - offset, `${pVar}${destructured.typeAnn}${defSuffix}`)
      ;({ rewrites: propRewrites, prelude } = computePropRewrites(destructured, pVar, outerRewrites))
    }

    if (fn.body !== null)
      fnEditor.replace(fn.body.start - offset, fn.body.end - offset, withPrelude(compileExpression(fn.body, propRewrites), fn.body, prelude))
    return fnEditor.toString()
  }

  // Handle top-level component functions with destructured props + JSX compilation
  function processFunction(fn: ArrowFunctionExpression | OxcFunction): void {
    if (fn.body === null || !containsJsx(fn.body, jsxNodes))
      return

    const destructured = extractDestructuredParam(fn.params[0])
    let propRewrites = new Map<string, string>()
    let prelude = ''

    if (destructured !== undefined) {
      const pVar = '__p'
      const defSuffix = destructured.defaultExpr !== undefined
        ? ` = ${compileExpression(destructured.defaultExpr, new Map())}`
        : ''
      editor.replace(destructured.replaceStart, destructured.replaceEnd, `${pVar}${destructured.typeAnn}${defSuffix}`)
      ;({ rewrites: propRewrites, prelude } = computePropRewrites(destructured, pVar, new Map()))
    }

    if (propRewrites.size > 0 && fn.body.type === 'BlockStatement') {
      if (prelude !== '')
        editor.replace(fn.body.start + 1, fn.body.start + 1, ` ${prelude}`)
      const shadowed = new Set<string>()
      for (const stmt of fn.body.body) {
        if (stmt.type === 'FunctionDeclaration' && stmt.id !== null)
          shadowed.add(stmt.id.name)
        else if (stmt.type === 'ClassDeclaration' && stmt.id !== null)
          shadowed.add(stmt.id.name)
      }
      for (const stmt of fn.body.body) {
        const active = new Map<string, string>()
        for (const [k, v] of propRewrites) {
          if (!shadowed.has(k))
            active.set(k, v)
        }
        if (active.size > 0 || containsJsx(stmt, jsxNodes))
          editor.replace(stmt.start, stmt.end, compileExpression(stmt, active))
        if (stmt.type === 'VariableDeclaration') {
          for (const d of stmt.declarations)
            collectPatternNames(d.id, shadowed)
        }
      }
    }
    else {
      editor.replace(fn.body.start, fn.body.end, withPrelude(compileExpression(fn.body, propRewrites), fn.body, prelude))
    }
  }

  return { patternReads, extractDestructuredParam, buildCompiledFunction, processFunction }
}

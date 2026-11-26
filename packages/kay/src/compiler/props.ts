// Compiles a component's destructured props: reads stay reactive through `__p`, and the function is rewritten around it.

import type { ArrowFunctionExpression, Function as OxcFunction, Node, ObjectPattern, ParamPattern } from 'oxc-parser'
import { SourceEditor } from './patch'
import { collectMutatedNames, isSafeLazyJsxRef } from './scope'
import { collectPatternNames, containsJsx, isJsxNode, unwrapParens, unwrapTsExpr } from './shared'

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
  patternReads: (pattern: Node, source: string, outerRewrites: ReadonlyMap<string, string>, hoisted?: string[]) => Map<string, string>
  compileLoopRow: (opts: {
    firstParam: ParamPattern | undefined
    idxParam: string | undefined
    keyAst: Node | undefined
    rowSig: string
    scopeRewrites: ReadonlyMap<string, string>
    keyRewrites: ReadonlyMap<string, string>
  }) => { keyFn: string, rowRewrites: Map<string, string>, prelude: string }
  withPrelude: (compiledBody: string, body: Node, prelude: string) => string
  extractDestructuredParam: (firstParam: ParamPattern | undefined) => DestructuredParam | undefined
  buildCompiledFunction: (fn: ArrowFunctionExpression | OxcFunction, outerRewrites: ReadonlyMap<string, string>) => string
  processFunction: (fn: ArrowFunctionExpression | OxcFunction) => void
}

export function createPropCompiler(ctx: PropCompilerContext): PropCompiler {
  const { code, editor, jsxNodes, use, freshVar, compileExpression } = ctx

  // How each name a destructuring pattern binds is read from `source` on every access, so reads stay reactive.
  // With `hoisted`, a default (at any nesting depth) and a nested pattern's getter become statements for the start of the body (evaluated once per call/row) instead of running on every read.
  function patternReads(pattern: Node, source: string, outerRewrites: ReadonlyMap<string, string>, hoisted?: string[]): Map<string, string> {
    const reads = new Map<string, string>()
    const running = new Map(outerRewrites)
    const hoist = (init: string): string => {
      const name = freshVar('__d')
      hoisted!.push(`const ${name} = ${init};`)
      return name
    }

    function bindPattern(pat: Node, src: string): void {
      if (pat.type === 'Identifier') {
        reads.set(pat.name, src)
        running.set(pat.name, src)
        return
      }
      if (pat.type === 'AssignmentPattern') {
        const defExpr = compileExpression(pat.right, running)
        const simpleDef = pat.right.type === 'Literal' || pat.right.type === 'Identifier'
        let fallback = simpleDef ? defExpr : `(${defExpr})`
        if (!simpleDef && hoisted !== undefined)
          fallback = `${hoist(`${use('propDefault')}(() => (${defExpr}), ${src} === undefined)`)}()`
        let nextSrc: string
        if (pat.left.type !== 'Identifier' && hoisted !== undefined) {
          const v = freshVar('__v')
          nextSrc = `${hoist(`() => { const ${v} = ${src}; return ${v} === undefined ? ${fallback} : ${v}; }`)}()`
        }
        else {
          nextSrc = `(${src} === undefined ? ${fallback} : ${src})`
        }
        bindPattern(pat.left, nextSrc)
        return
      }
      if (pat.type === 'ObjectPattern') {
        const excludedKeys: string[] = []
        let canOmit = hoisted !== undefined
        for (const prop of pat.properties) {
          if (prop.type === 'RestElement') {
            if (canOmit) {
              const restRead = `${use('omit')}(${src}, [${excludedKeys.join(', ')}])`
              bindPattern(prop.argument, restRead)
            }
            continue
          }
          let propSrc: string | undefined
          if (!prop.computed && prop.key.type === 'Identifier') {
            excludedKeys.push(JSON.stringify(prop.key.name))
            propSrc = `${src}.${prop.key.name}`
          }
          else if (!prop.computed && prop.key.type === 'Literal' && (typeof prop.key.value === 'string' || typeof prop.key.value === 'number')) {
            excludedKeys.push(JSON.stringify(String(prop.key.value)))
            propSrc = `${src}[${JSON.stringify(prop.key.value)}]`
          }
          else if (prop.computed && hoisted !== undefined) {
            const keyVar = hoist(compileExpression(prop.key, running))
            excludedKeys.push(`typeof ${keyVar} === 'symbol' ? ${keyVar} : String(${keyVar})`)
            propSrc = `${src}[${keyVar}]`
          }
          else {
            canOmit = false
          }
          if (propSrc !== undefined)
            bindPattern(prop.value, propSrc)
        }
        return
      }
      if (pat.type === 'ArrayPattern') {
        for (let i = 0; i < pat.elements.length; i++) {
          const el = pat.elements[i]
          if (el == null)
            continue
          if (el.type === 'RestElement')
            bindPattern(el.argument, `Array.from(${src}).slice(${i})`)
          else
            bindPattern(el, `${src}[${i}]`)
        }
      }
    }

    bindPattern(pattern, source)

    const compilePatternSource = (patNode: Node): string => {
      const sub = new SourceEditor(code.slice(patNode.start, patNode.end))
      const base = patNode.start
      const patchPattern = (p: Node | null | undefined): void => {
        if (p === null || p === undefined)
          return
        if ('typeAnnotation' in p && p.typeAnnotation != null) {
          const ann = p.typeAnnotation as Node
          sub.remove(ann.start - base, ann.end - base)
        }
        switch (p.type) {
          case 'AssignmentPattern':
            patchPattern(p.left)
            sub.replace(p.right.start - base, p.right.end - base, compileExpression(p.right, outerRewrites))
            return
          case 'RestElement':
            patchPattern(p.argument)
            return
          case 'ArrayPattern':
            for (const el of p.elements)
              patchPattern(el)
            return
          case 'ObjectPattern':
            for (const prop of p.properties) {
              if (prop.type === 'RestElement') {
                patchPattern(prop.argument)
              }
              else {
                if (prop.computed)
                  sub.replace(prop.key.start - base, prop.key.end - base, compileExpression(prop.key, outerRewrites))
                patchPattern(prop.value)
              }
            }
        }
      }
      patchPattern(patNode)
      return sub.toString()
    }

    const names = new Set<string>()
    collectPatternNames(pattern, names)
    // The pattern a read runs: only the property binding `name`, so another property's default does not run on this read.
    const patternFor = (name: string): string => {
      if (pattern.type === 'ObjectPattern') {
        for (const prop of (pattern as ObjectPattern).properties) {
          const bound = new Set<string>()
          collectPatternNames(prop.type === 'RestElement' ? prop.argument : prop.value, bound)
          if (prop.type === 'Property' && bound.has(name)) {
            const sub = new SourceEditor(code.slice(prop.start, prop.end))
            const base = prop.start
            if (prop.computed)
              sub.replace(prop.key.start - base, prop.key.end - base, compileExpression(prop.key, outerRewrites))
            sub.replace(prop.value.start - base, prop.value.end - base, compilePatternSource(prop.value))
            return `{ ${sub.toString()} }`
          }
        }
      }
      return compilePatternSource(pattern)
    }
    for (const name of names) {
      if (reads.has(name))
        continue
      const getter = `(${patternFor(name)}) => ${name}`
      reads.set(name, hoisted === undefined ? `(${getter})(${source})` : `${hoist(getter)}(${source})`)
    }
    return reads
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

  function patchParamDefaults(param: Node | null | undefined, rewrites: ReadonlyMap<string, string>, targetEditor: SourceEditor, offset: number): void {
    if (param === null || param === undefined)
      return
    switch (param.type) {
      case 'AssignmentPattern':
        patchParamDefaults(param.left, rewrites, targetEditor, offset)
        targetEditor.replace(param.right.start - offset, param.right.end - offset, compileExpression(param.right, rewrites))
        return
      case 'RestElement':
        patchParamDefaults(param.argument, rewrites, targetEditor, offset)
        return
      case 'TSParameterProperty':
        patchParamDefaults(param.parameter, rewrites, targetEditor, offset)
        return
      case 'ArrayPattern':
        for (const el of param.elements)
          patchParamDefaults(el, rewrites, targetEditor, offset)
        return
      case 'ObjectPattern':
        for (const prop of param.properties) {
          if (prop.type === 'RestElement') {
            patchParamDefaults(prop.argument, rewrites, targetEditor, offset)
          }
          else {
            if (prop.computed)
              targetEditor.replace(prop.key.start - offset, prop.key.end - offset, compileExpression(prop.key, rewrites))
            patchParamDefaults(prop.value, rewrites, targetEditor, offset)
          }
        }
    }
  }

  function computePropRewrites(
    destructured: { pattern: ObjectPattern, defaultExpr: Node | undefined },
    pVar: string,
    outerRewrites: ReadonlyMap<string, string>,
    body: Node | null,
  ): { rewrites: Map<string, string>, prelude: string } {
    const rewrites = new Map(outerRewrites)
    const hoisted: string[] = []
    const propReads = patternReads(destructured.pattern, pVar, outerRewrites, hoisted)
    const mutated = collectMutatedNames(body, new Set(propReads.keys()))
    for (const [name, read] of propReads) {
      if (mutated.has(name)) {
        // A mutated destructured prop becomes a local `let` binding initialized once, avoiding invalid assignment targets like `(a === undefined ? b : a) = c`.
        hoisted.push(`let ${name} = ${read};`)
        rewrites.delete(name)
      }
      else {
        rewrites.set(name, read)
      }
    }
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
    const baseRewrites = new Map(outerRewrites)
    if (fn.type !== 'ArrowFunctionExpression' && fn.id !== null)
      baseRewrites.delete(fn.id.name)
    let propRewrites = baseRewrites
    let prelude = ''

    if (destructured !== undefined) {
      const defSuffix = destructured.defaultExpr !== undefined
        ? ` = ${compileExpression(destructured.defaultExpr, baseRewrites)}`
        : ''
      fnEditor.replace(destructured.replaceStart - offset, destructured.replaceEnd - offset, `${pVar}${destructured.typeAnn}${defSuffix}`)
      ;({ rewrites: propRewrites, prelude } = computePropRewrites(destructured, pVar, baseRewrites, fn.body))
    }

    for (let i = 1; i < fn.params.length; i++) {
      const extraParam = fn.params[i]!
      patchParamDefaults(extraParam, propRewrites, fnEditor, offset)
      propRewrites = withoutBindings(propRewrites, [extraParam])
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
      ;({ rewrites: propRewrites, prelude } = computePropRewrites(destructured, pVar, new Map(), fn.body))
    }

    for (let i = 1; i < fn.params.length; i++) {
      const extraParam = fn.params[i]!
      patchParamDefaults(extraParam, propRewrites, editor, 0)
      propRewrites = withoutBindings(propRewrites, [extraParam])
    }

    const hasLazyJsxDecl = fn.body.type === 'BlockStatement' && fn.body.body.some(s =>
      s.type === 'VariableDeclaration' && s.kind === 'const' && s.declarations.length === 1
      && s.declarations[0]!.id.type === 'Identifier' && s.declarations[0]!.init !== null
      && isJsxNode(unwrapParens(s.declarations[0]!.init)),
    )

    if ((propRewrites.size > 0 || hasLazyJsxDecl) && fn.body.type === 'BlockStatement') {
      if (prelude !== '')
        editor.replace(fn.body.start + 1, fn.body.start + 1, ` ${prelude}`)
      const shadowed = new Set<string>()
      for (const stmt of fn.body.body) {
        if (stmt.type === 'FunctionDeclaration' && stmt.id !== null)
          shadowed.add(stmt.id.name)
        else if (stmt.type === 'ClassDeclaration' && stmt.id !== null)
          shadowed.add(stmt.id.name)
      }
      const stmts = fn.body.body
      for (let i = 0; i < stmts.length; i++) {
        const stmt = stmts[i]!
        const active = new Map<string, string>()
        for (const [k, v] of propRewrites) {
          if (!shadowed.has(k))
            active.set(k, v)
        }
        // Defer `const badge = <span />` to `const badge = () => _t0()` when only used in JSX slots so SSR hydration claims the outer element before the slot's nodes.
        if (
          stmt.type === 'VariableDeclaration' && stmt.kind === 'const' && stmt.declarations.length === 1
          && stmt.declarations[0]!.id.type === 'Identifier' && stmt.declarations[0]!.init !== null
        ) {
          const decl = stmt.declarations[0]!
          const jsxInit = unwrapParens(decl.init!)
          const varName = (decl.id as Extract<Node, { type: 'Identifier' }>).name
          if (isJsxNode(jsxInit) && isSafeLazyJsxRef(varName, stmts.slice(i + 1))) {
            editor.replace(stmt.start, stmt.end, `const ${varName} = () => ${compileExpression(jsxInit, active)};`)
            propRewrites.set(varName, `${varName}()`)
            shadowed.delete(varName)
            continue
          }
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

  function compileLoopRow(opts: {
    firstParam: ParamPattern | undefined
    idxParam: string | undefined
    keyAst: Node | undefined
    rowSig: string
    scopeRewrites: ReadonlyMap<string, string>
    keyRewrites: ReadonlyMap<string, string>
  }): { keyFn: string, rowRewrites: Map<string, string>, prelude: string } {
    const { firstParam, idxParam, keyAst, rowSig, scopeRewrites, keyRewrites } = opts
    const rowRewrites = new Map(scopeRewrites)
    const hoisted: string[] = []
    let keyFn: string
    if (firstParam !== undefined && firstParam.type !== 'Identifier') {
      if (keyAst !== undefined) {
        const keyItem = freshVar('_item')
        const keyScope = new Map(keyRewrites)
        for (const [name, read] of patternReads(firstParam, keyItem, scopeRewrites))
          keyScope.set(name, read)
        keyFn = `(${keyItem}${idxParam ? `, ${idxParam}` : ''}) => ${compileExpression(keyAst, keyScope)}`
      }
      else {
        keyFn = `(_item) => _item`
      }
      for (const [name, read] of patternReads(firstParam, `${rowSig}.value`, scopeRewrites, hoisted))
        rowRewrites.set(name, read)
    }
    else {
      const itemParam = firstParam?.type === 'Identifier' ? firstParam.name : '_item'
      keyFn = keyAst !== undefined
        ? `(${itemParam}${idxParam ? `, ${idxParam}` : ''}) => ${compileExpression(keyAst, keyRewrites)}`
        : `(${itemParam}) => ${itemParam}`
      rowRewrites.set(itemParam, `${rowSig}.value`)
    }
    return { keyFn, rowRewrites, prelude: hoisted.join(' ') }
  }

  return { patternReads, compileLoopRow, withPrelude, extractDestructuredParam, buildCompiledFunction, processFunction }
}

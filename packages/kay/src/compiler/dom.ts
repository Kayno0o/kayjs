// Kay v2 Client DOM compiler: compiles TSX to hoisted template() clones, child-path walks,
// delegated events, compiler-safe destructured props, reactive spreads, and shared balanced hydration markers.

import type {
  ArrowFunctionExpression,
  BlockStatement,
  Function as OxcFunction,
  JSXElement,
  JSXFragment,
  Node,
} from 'oxc-parser'
import type { ModuleAnalysis } from './analyze'
import type { WalkItem } from './emit'
import type { HydrationMarker, MapCallMatch } from './shared'

import { analyzeModule, loadDeclarations, parseTsx } from './analyze'
import { walk } from './ast'
import { compileElementAttributes, compileRawTextChildren, resolveComponentCallee } from './dom-attrs'
import { emitWalkStatements, moduleHeader, SVG_CHILD_TAGS } from './emit'
import { SourceEditor } from './patch'
import { createPropCompiler, isStaticPropExpr, withoutBindings } from './props'
import { extractBlockKeyExpr, extractKeyExpr, literalArrayConsts, rewriteFreeIdentifiers } from './scope'
import {
  cleanJsxText,
  containsJsx,
  createExprContext,
  decodeHtmlEntities,
  escapeStaticText,
  filterMeaningfulChildren,
  isComponentTag,
  isJsxNode,
  jsxTagName,
  planChildSlots,
  RAW_TEXT_ELEMENTS,
  VOID_ELEMENTS,
} from './shared'

export interface CompileDomOptions {
  analysis?: ModuleAnalysis | undefined
}

export interface CompileDomResult {
  code: string
  analysis: ModuleAnalysis
}

export function compileDom(filename: string, code: string, options: CompileDomOptions = {}): CompileDomResult {
  const program = options.analysis?.program ?? parseTsx(filename, code)
  const analysis = options.analysis ?? analyzeModule(filename, code, program)

  if (!analysis.hasJsx && !analysis.hasLoadExport)
    return { code, analysis }

  const staticArrays = literalArrayConsts(program)
  const loadNodes = new Set<Node>(loadDeclarations(program))
  const jsxNodes = analysis.jsxNodes
  const exprContext = createExprContext(program, jsxNodes)

  const editor = new SourceEditor(code)
  const used = new Set<string>()
  const templates: { name: string, html: string, isSvg?: boolean }[] = []
  const delegatedEvents = new Set<string>()
  let varCounter = 0
  // Tracks whether the current JSX tree is enclosed by `<svg>` (reset inside `<foreignObject>`).
  let svgDepth = 0

  const use = (name: string): string => {
    used.add(name)
    return `__${name}`
  }
  const freshVar = (prefix = '_e'): string => `${prefix}${varCounter++}`

  // Client builds keep the `load` binding, so every export form stays valid, and drop its server-only code.
  for (const node of loadNodes) {
    if (node.type === 'FunctionDeclaration' && node.id !== null)
      editor.replace(node.start, node.end, `const ${node.id.name} = undefined`)
    else
      editor.replace(node.start, node.end, 'undefined')
  }

  const { compileLoopRow, withPrelude, extractDestructuredParam, buildCompiledFunction, processFunction } = createPropCompiler({
    code,
    editor,
    jsxNodes,
    use,
    freshVar,
    compileExpression: (node, rewrites) => compileExpression(node, rewrites),
  })

  function compileNestedComponent(fn: ArrowFunctionExpression | OxcFunction, outerRewrites: ReadonlyMap<string, string>): string | undefined {
    if (!containsJsx(fn.body, jsxNodes))
      return undefined
    const firstParam = fn.params[0]
    const destructured = extractDestructuredParam(firstParam)
    if (destructured === undefined)
      return undefined
    return buildCompiledFunction(fn, outerRewrites)
  }

  function compileExpression(node: Node, scopeRewrites: ReadonlyMap<string, string>): string {
    return rewriteFreeIdentifiers(code, node, scopeRewrites, jsxNodes, compileRootJsx, compileNestedComponent)
  }

  function compileComponentCall(node: JSXElement, scopeRewrites: ReadonlyMap<string, string>): string {
    const tag = jsxTagName(node.openingElement.name)
    const callee = resolveComponentCallee(tag, scopeRewrites)
    const attrs = node.openingElement.attributes
    const hasSpread = attrs.some(a => a.type === 'JSXSpreadAttribute')
    const segments: string[] = []
    let currentObj: string[] = []

    const flushObj = () => {
      if (currentObj.length > 0) {
        segments.push(`{ ${currentObj.join(', ')} }`)
        currentObj = []
      }
    }

    for (const attr of attrs) {
      if (attr.type === 'JSXSpreadAttribute') {
        flushObj()
        segments.push(`(${compileExpression(attr.argument, scopeRewrites)})`)
        continue
      }
      const name = jsxTagName(attr.name)
      if (name === 'key' || name === '$hydrate')
        continue

      const propKey = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
      if (attr.value === null) {
        currentObj.push(`${propKey}: true`)
      }
      else if (attr.value.type === 'Literal') {
        currentObj.push(`${propKey}: ${JSON.stringify(attr.value.value)}`)
      }
      else if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
        const expr = attr.value.expression
        const exprCode = compileExpression(expr, scopeRewrites)
        // Reactive getter for dynamic expressions; plain property for identifiers, constant literals/collections, and inline functions.
        if (isStaticPropExpr(expr, scopeRewrites))
          currentObj.push(`${propKey}: ${exprCode}`)
        else
          currentObj.push(`get ${propKey}() { return ${exprCode} }`)
      }
    }

    const meaningful = filterMeaningfulChildren(node.children)
    if (meaningful.length === 1) {
      const child = meaningful[0]!
      if (child.type === 'JSXText')
        currentObj.push(`children: ${JSON.stringify(decodeHtmlEntities(cleanJsxText(child.value)))}`)
      else if (isJsxNode(child))
        currentObj.push(`get children() { return ${compileRootJsx(child, scopeRewrites)} }`)
      else if (child.type === 'JSXExpressionContainer' && child.expression.type !== 'JSXEmptyExpression')
        currentObj.push(`get children() { return ${compileExpression(child.expression, scopeRewrites)} }`)
    }
    else if (meaningful.length > 1) {
      const items = meaningful.map((c) => {
        if (c.type === 'JSXText')
          return JSON.stringify(decodeHtmlEntities(cleanJsxText(c.value)))
        if (isJsxNode(c))
          return compileRootJsx(c, scopeRewrites)
        if (c.type === 'JSXExpressionContainer' && c.expression.type !== 'JSXEmptyExpression')
          return compileExpression(c.expression, scopeRewrites)
        return 'null'
      })
      currentObj.push(`get children() { return [${items.join(', ')}] }`)
    }

    flushObj()

    if (!hasSpread) {
      const propsObj = segments[0] ?? '{}'
      return `${callee}(${propsObj})`
    }
    if (segments.length === 1)
      return `${callee}(${segments[0]!})`
    return `${callee}(${use('mergeProps')}(${segments.join(', ')}))`
  }

  /** Compiles a `.map()` JSX loop into either `__eachStatic` or keyed `__loop`, reusable for both element children and fragments. */
  function compileLoopCall(
    match: MapCallMatch,
    scopeRewrites: ReadonlyMap<string, string>,
    parentExpr: string,
    anchorExpr: string,
    skipArg = '',
  ): { isStatic: boolean, call: (p: string, a: string) => string } {
    const eachCode = compileExpression(match.target, scopeRewrites)
    const params = match.params
    const firstParam = params[0]
    const secondParam = params[1]
    const idxParam = secondParam?.type === 'Identifier'
      ? secondParam.name
      : secondParam?.type === 'AssignmentPattern' && secondParam.left.type === 'Identifier'
        ? secondParam.left.name
        : undefined

    // Fast path: a const array literal (e.g. `NAV.map(...)`) renders once through `eachStatic`.
    const isStaticArr = match.target.type === 'Identifier' && staticArrays.has(match.target.name) && !scopeRewrites.has(match.target.name)
    if (isStaticArr) {
      const rawParams = params.map(p => code.slice(p.start, p.end)).join(', ')
      const shadowed = withoutBindings(scopeRewrites, params)
      const rowBody = match.isJsxBody ? compileRootJsx(match.body as JSXElement | JSXFragment, shadowed) : compileExpression(match.body, shadowed)
      return {
        isStatic: true,
        call: (p, a) => `${use('eachStatic')}(${p}, ${a}, ${eachCode}, (${rawParams}) => ${rowBody}${skipArg})`,
      }
    }

    const keyAst = match.isJsxBody ? extractKeyExpr(match.body) : extractBlockKeyExpr(match.body as BlockStatement)
    const rowSig = freshVar('_r')
    const idxSig = idxParam !== undefined ? freshVar('_i') : undefined
    const keyRewrites = withoutBindings(scopeRewrites, params)
    const { keyFn, rowRewrites, prelude } = compileLoopRow({ firstParam, idxParam, keyAst, rowSig, scopeRewrites, keyRewrites })
    if (idxParam !== undefined && idxSig !== undefined)
      rowRewrites.set(idxParam, `${idxSig}.value`)

    const rawRowBody = match.isJsxBody ? compileRootJsx(match.body as JSXElement | JSXFragment, rowRewrites) : compileExpression(match.body, rowRewrites)
    const rowBody = withPrelude(rawRowBody, match.body, prelude)
    const rowParams = idxSig !== undefined ? `${rowSig}, ${idxSig}` : rowSig
    void parentExpr
    void anchorExpr
    return {
      isStatic: false,
      call: (p, a) => `${use('loop')}(${p}, ${a}, () => ${eachCode}, ${keyFn}, (${rowParams}) => ${rowBody}${skipArg})`,
    }
  }

  function compileElementTree(rootEl: JSXElement, scopeRewrites: ReadonlyMap<string, string>): string {
    const ops: string[] = []
    const rootVar = freshVar('_e')
    const childRefs = new Map<string, string>() // "parentVar:index" -> varName

    const walkPlan: WalkItem[] = []
    const textSlotsByParent = new Map<string, Set<number>>()
    const rangeSlotsByParent = new Map<string, Set<number>>()

    const addTextSlot = (parentVar: string, idx: number) => {
      let s = textSlotsByParent.get(parentVar)
      if (s === undefined) {
        s = new Set()
        textSlotsByParent.set(parentVar, s)
      }
      s.add(idx)
    }

    const addRangeSlot = (parentVar: string, idx: number) => {
      let s = rangeSlotsByParent.get(parentVar)
      if (s === undefined) {
        s = new Set()
        rangeSlotsByParent.set(parentVar, s)
      }
      s.add(idx)
    }

    function requestChild(parentVar: string, index: number): string {
      const key = `${parentVar}:${index}`
      const existing = childRefs.get(key)
      if (existing !== undefined)
        return existing
      const v = freshVar('_e')
      childRefs.set(key, v)
      walkPlan.push({ parentVar, index, varName: v })
      return v
    }

    function buildHtml(el: JSXElement, elVar: string): string {
      const tag = jsxTagName(el.openingElement.name)
      const rawTextTag = RAW_TEXT_ELEMENTS.has(tag) ? tag as 'style' | 'script' : undefined
      const postChildOps: string[] = []
      const attrHtml = compileElementAttributes({
        el,
        tag,
        elVar,
        scopeRewrites,
        ops,
        postChildOps,
        delegatedEvents,
        use,
        freshVar,
        compileExpression,
      })

      let html = `<${tag}${attrHtml}>`
      if (VOID_ELEMENTS.has(tag))
        return html

      if (rawTextTag !== undefined) {
        html += compileRawTextChildren(el, rawTextTag, elVar, scopeRewrites, ops, use, compileExpression)
        html += `</${tag}>`
        return html
      }

      const planned = planChildSlots(el.children, { jsxNodes, exprContext })
      let domIndex = 0
      let prevWasStaticText = false

      const claimRangeAnchor = (marker: HydrationMarker, open: string, close: string): string => {
        if (marker !== 'range')
          return 'null'
        const v = requestChild(elVar, domIndex)
        html += open + close
        addRangeSlot(elVar, domIndex + 1)
        domIndex += 2
        return v
      }

      const emitInsert = (valueCode: string, marker: HydrationMarker, open: string, close: string): void => {
        if (marker === 'none') {
          ops.push(`${use('insert')}(${elVar}, () => ${valueCode}, null, null);`)
        }
        else if (marker === 'range-open') {
          const startVar = requestChild(elVar, domIndex)
          html += open
          domIndex++
          ops.push(`${use('insert')}(${elVar}, () => ${valueCode}, null, ${startVar});`)
        }
        else {
          const startVar = requestChild(elVar, domIndex)
          const endVar = requestChild(elVar, domIndex + 1)
          html += open + close
          addRangeSlot(elVar, domIndex + 1)
          domIndex += 2
          ops.push(`${use('insert')}(${elVar}, () => ${valueCode}, ${endVar}, ${startVar});`)
        }
      }

      const prevSvgDepth = svgDepth
      if (tag === 'svg')
        svgDepth = 1
      else if (tag === 'foreignObject')
        svgDepth = 0

      try {
        for (const { slot, marker, open, close, nodeCapable } of planned) {
          if (slot.kind === 'static-text') {
            html += escapeStaticText(slot.fromLiteral ? slot.text : decodeHtmlEntities(slot.text))
            if (!prevWasStaticText) {
              domIndex++
              prevWasStaticText = true
            }
            continue
          }

          prevWasStaticText = false

          if (slot.kind === 'element') {
            const subOpsBefore = ops.length
            const subWalkBefore = walkPlan.length
            const placeholderVar = `__SUB_${varCounter++}`
            const subHtml = buildHtml(slot.node, placeholderVar)
            const needed = ops.length > subOpsBefore || walkPlan.length > subWalkBefore
            if (needed) {
              const realVar = requestChild(elVar, domIndex)
              for (let k = subOpsBefore; k < ops.length; k++)
                ops[k] = ops[k]!.replaceAll(placeholderVar, realVar)
              for (let k = subWalkBefore; k < walkPlan.length; k++) {
                if (walkPlan[k]!.parentVar === placeholderVar)
                  walkPlan[k]!.parentVar = realVar
              }
              const tSlots = textSlotsByParent.get(placeholderVar)
              if (tSlots !== undefined) {
                textSlotsByParent.delete(placeholderVar)
                textSlotsByParent.set(realVar, tSlots)
              }
              const rSlots = rangeSlotsByParent.get(placeholderVar)
              if (rSlots !== undefined) {
                rangeSlotsByParent.delete(placeholderVar)
                rangeSlotsByParent.set(realVar, rSlots)
              }
            }
            html += subHtml
            domIndex++
            continue
          }

          if (slot.kind === 'component' || slot.kind === 'fragment') {
            const renderedCode = slot.kind === 'component'
              ? compileComponentCall(slot.node, scopeRewrites)
              : compileRootJsx(slot.node, scopeRewrites)
            emitInsert(renderedCode, marker, open, close)
            continue
          }

          if (slot.kind === 'loop') {
            const anchorVar = claimRangeAnchor(marker, open, close)
            const skipArg = marker === 'none' && domIndex > 0 ? `, ${domIndex}` : ''
            const compiled = compileLoopCall(slot.match, scopeRewrites, elVar, anchorVar, skipArg)
            ops.push(`${compiled.call(elVar, anchorVar)};`)
            continue
          }

          if (slot.kind === 'and-show') {
            const anchorVar = claimRangeAnchor(marker, open, close)
            const whenCode = compileExpression(slot.expr.left, scopeRewrites)
            const trueCode = compileRootJsx(slot.right, scopeRewrites)
            ops.push(`${use('show')}(${elVar}, ${anchorVar}, () => ${whenCode}, () => ${trueCode});`)
            continue
          }

          if (slot.kind === 'ternary-show') {
            const anchorVar = claimRangeAnchor(marker, open, close)
            const whenCode = compileExpression(slot.expr.test, scopeRewrites)
            const trueCode = isJsxNode(slot.cons)
              ? compileRootJsx(slot.cons, scopeRewrites)
              : compileExpression(slot.cons, scopeRewrites)
            const falseCode = isJsxNode(slot.alt)
              ? compileRootJsx(slot.alt, scopeRewrites)
              : compileExpression(slot.alt, scopeRewrites)
            ops.push(`${use('show')}(${elVar}, ${anchorVar}, () => ${whenCode}, () => ${trueCode}, () => ${falseCode});`)
            continue
          }

          // Generic expression slot
          const exprCode = compileExpression(slot.expr, scopeRewrites)
          if (nodeCapable) {
            emitInsert(exprCode, marker, open, close)
          }
          else {
            const txtVar = freshVar('_txt')
            if (marker === 'none') {
              html += ' '
              domIndex++
              ops.push(`const ${txtVar} = ${use('firstText')}(${elVar});`)
            }
            else {
              const markerVar = requestChild(elVar, domIndex)
              if (marker === 'text') {
                html += `${open} ${close}`
                addTextSlot(elVar, domIndex + 1)
                domIndex += 3
              }
              else {
                html += `${open} `
                domIndex += 2
              }
              ops.push(`const ${txtVar} = ${use('textAfter')}(${markerVar});`)
            }
            ops.push(`${use('effect')}(() => ${use('setText')}(${txtVar}, ${exprCode}));`)
          }
        }
      }
      finally {
        svgDepth = prevSvgDepth
      }

      for (const op of postChildOps)
        ops.push(op)

      html += `</${tag}>`
      return html
    }

    const html = buildHtml(rootEl, rootVar)
    const rootTag = jsxTagName(rootEl.openingElement.name)
    const tmplName = `_t${templates.length}`
    const isSvg = svgDepth > 0 ? rootTag !== 'svg' : SVG_CHILD_TAGS.has(rootTag)
    templates.push({ name: tmplName, html, isSvg })

    const walkStmts = emitWalkStatements(rootVar, walkPlan, textSlotsByParent, rangeSlotsByParent, use)

    if (walkStmts.length === 0 && ops.length === 0)
      return `${tmplName}()`

    return `(() => { const ${rootVar} = ${tmplName}(); ${walkStmts.join(' ')} ${ops.join(' ')} return ${rootVar}; })()`
  }

  function compileFragment(node: JSXFragment, scopeRewrites: ReadonlyMap<string, string>): string {
    const planned = planChildSlots(node.children, { jsxNodes, exprContext, inFragment: true })
    if (planned.length === 0)
      return 'null'

    const hasSiblings = planned.length > 1
    // Coalesce consecutive static-text slots (e.g. `<>a{"b"}c</>`) so DOM matches the single merged SSR text node.
    const items: string[] = []
    let pendingStatic: string | undefined
    const flushStatic = () => {
      if (pendingStatic !== undefined) {
        items.push(`${use('fragText')}(${JSON.stringify(pendingStatic)})`)
        pendingStatic = undefined
      }
    }

    const emitFragRangeOp = (hydrateCall: string, mountCall: string, needsRemoveChild: boolean): string => {
      const removeProp = needsRemoveChild ? ', removeChild: (n) => n.parentNode && n.parentNode.removeChild(n)' : ''
      return `(() => { const _s = ${use('claimRange')}(); if (_s !== null) { ${hydrateCall}; return null; } const _f = document.createDocumentFragment(); _f.appendChild(document.createComment("")); const _m = _f.appendChild(document.createComment("")); const _p = { insertBefore: (n, r) => (_m.parentNode || _f).insertBefore(n, r)${removeProp} }; ${mountCall}; return _f; })()`
    }

    for (const { slot, marker } of planned) {
      if (slot.kind === 'static-text') {
        const decoded = slot.fromLiteral ? slot.text : decodeHtmlEntities(slot.text)
        pendingStatic = pendingStatic === undefined ? decoded : pendingStatic + decoded
        continue
      }
      flushStatic()

      if (slot.kind === 'element') {
        items.push(compileRootJsx(slot.node, scopeRewrites))
      }
      else if (slot.kind === 'component' || slot.kind === 'fragment') {
        const rendered = compileRootJsx(slot.node, scopeRewrites)
        items.push(hasSiblings ? `${use('fragInsert')}(() => ${rendered})` : rendered)
      }
      else if (slot.kind === 'loop') {
        const compiled = compileLoopCall(slot.match, scopeRewrites, '_s.parentNode', '_s')
        if (compiled.isStatic)
          items.push(`(() => { const _s = ${use('claimRange')}(); if (_s !== null) { ${compiled.call('_s.parentNode', '_s')}; return null; } const _f = document.createDocumentFragment(); ${compiled.call('_f', 'null')}; return _f; })()`)
        else
          items.push(emitFragRangeOp(compiled.call('_s.parentNode', '_s'), compiled.call('_p', '_m'), true))
      }
      else if (slot.kind === 'and-show') {
        const whenCode = compileExpression(slot.expr.left, scopeRewrites)
        const trueCode = compileRootJsx(slot.right, scopeRewrites)
        items.push(emitFragRangeOp(
          `${use('show')}(_s.parentNode, _s, () => ${whenCode}, () => ${trueCode})`,
          `${use('show')}(_p, _m, () => ${whenCode}, () => ${trueCode})`,
          false,
        ))
      }
      else if (slot.kind === 'ternary-show') {
        const whenCode = compileExpression(slot.expr.test, scopeRewrites)
        const trueCode = isJsxNode(slot.cons)
          ? compileRootJsx(slot.cons, scopeRewrites)
          : compileExpression(slot.cons, scopeRewrites)
        const falseCode = isJsxNode(slot.alt)
          ? compileRootJsx(slot.alt, scopeRewrites)
          : compileExpression(slot.alt, scopeRewrites)
        items.push(emitFragRangeOp(
          `${use('show')}(_s.parentNode, _s, () => ${whenCode}, () => ${trueCode}, () => ${falseCode})`,
          `${use('show')}(_p, _m, () => ${whenCode}, () => ${trueCode}, () => ${falseCode})`,
          false,
        ))
      }
      else {
        const exprCode = compileExpression(slot.expr, scopeRewrites)
        if (marker === 'range')
          items.push(`${use('fragInsert')}(() => (${exprCode}))`)
        else
          items.push(`(() => { const _t = ${use('fragText')}("", true); ${use('effect')}(() => ${use('setText')}(_t, (${exprCode}))); return _t; })()`)
      }
    }
    flushStatic()

    if (items.length === 1)
      return items[0]!
    return `${use('frag')}(${items.join(', ')})`
  }

  function compileRootJsx(node: JSXElement | JSXFragment, scopeRewrites: ReadonlyMap<string, string>): string {
    if (node.type === 'JSXFragment')
      return compileFragment(node, scopeRewrites)

    const tag = jsxTagName(node.openingElement.name)
    if (isComponentTag(tag))
      return compileComponentCall(node, scopeRewrites)

    return compileElementTree(node, scopeRewrites)
  }

  walk(program, (node) => {
    if (loadNodes.has(node))
      return false
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      processFunction(node)
      return false
    }
    if (isJsxNode(node)) {
      editor.replace(node.start, node.end, compileRootJsx(node, new Map()))
      return false
    }
    return undefined
  })

  const header = moduleHeader(used, templates, delegatedEvents)
  if (header !== '')
    editor.prepend(header)

  return { code: editor.toString(), analysis }
}

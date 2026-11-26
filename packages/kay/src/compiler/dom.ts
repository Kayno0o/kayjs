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

import { analyzeModule, loadDeclarations, parseTsx } from './analyze'
import { walk } from './ast'
import { SourceEditor } from './patch'
import type { WalkItem } from './emit'
import { DELEGATED_EVENTS, emitWalkStatements, moduleHeader, SVG_CHILD_TAGS } from './emit'
import { createPropCompiler, isStaticPropExpr, withoutBindings } from './props'
import { extractBlockKeyExpr, extractKeyExpr, literalArrayConsts, rewriteFreeIdentifiers } from './scope'
import {
  classifyJsxChild,
  cleanJsxText,
  containsJsx,
  decodeHtmlEntities,
  DOM_PROPS,
  escapeRawText,
  escapeStaticAttr,
  escapeStaticText,
  EVENT_ATTR,
  filterMeaningfulChildren,
  isBlockedAttr,
  isComponentTag,
  isJsxNode,
  isNodeCapableExpr,
  isStringBoolAttr,
  isUnsafeUrlAttr,
  jsxTagName,
  RAW_TEXT_ELEMENTS,
  staticLiteral,
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

  const { patternReads, extractDestructuredParam, buildCompiledFunction, processFunction } = createPropCompiler({
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
      return `${tag}(${propsObj})`
    }
    if (segments.length === 1)
      return `${tag}(${segments[0]!})`
    return `${tag}(${use('mergeProps')}(${segments.join(', ')}))`
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
      let html = `<${tag}`

      for (const attr of el.openingElement.attributes) {
        if (attr.type === 'JSXSpreadAttribute') {
          ops.push(`${use('spread')}(${elVar}, () => (${compileExpression(attr.argument, scopeRewrites)}));`)
          continue
        }
        const rawName = jsxTagName(attr.name)
        if (rawName === 'key' || rawName === '$hydrate')
          continue

        if (rawName === 'ref') {
          if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
            const refCode = compileExpression(attr.value.expression, scopeRewrites)
            ops.push(`(${refCode})(${elVar});`)
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
            const eventName = eventMatch[1]!.toLowerCase()
            const handlerCode = compileExpression(attr.value.expression, scopeRewrites)
            if (DELEGATED_EVENTS.has(eventName)) {
              delegatedEvents.add(eventName)
              ops.push(`${elVar}.$$${eventName} = ${handlerCode};`)
            }
            else {
              ops.push(`${use('on')}(${elVar}, ${JSON.stringify(eventName)}, ${handlerCode});`)
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
          if (!isUnsafeUrlAttr(name, attr.value.value))
            html += ` ${name}="${escapeStaticAttr(String(attr.value.value))}"`
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
          if (name === 'class')
            ops.push(`${use('effect')}(() => ${use('setClass')}(${elVar}, ${exprCode}));`)
          else if (name === 'style')
            ops.push(`${use('effect')}(() => ${use('setStyle')}(${elVar}, ${exprCode}));`)
          else if (DOM_PROPS.has(name))
            ops.push(`${use('effect')}(() => ${use('setProp')}(${elVar}, ${JSON.stringify(name)}, ${exprCode}));`)
          else
            ops.push(`${use('effect')}(() => ${use('setAttr')}(${elVar}, ${JSON.stringify(name)}, ${exprCode}));`)
        }
      }

      html += '>'
      if (VOID_ELEMENTS.has(tag))
        return html

      const meaningful = filterMeaningfulChildren(el.children)
      const slots = meaningful.map(c => classifyJsxChild(c, jsxNodes)).filter(s => s !== undefined)
      const hasSiblings = slots.length > 1
      let domIndex = 0
      let prevWasStaticText = false
      let hadVariableRange = false

      const prevSvgDepth = svgDepth
      if (tag === 'svg')
        svgDepth = 1
      else if (tag === 'foreignObject')
        svgDepth = 0

      try {
        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i]!
          const isLast = i === slots.length - 1

          if (slot.kind === 'static-text') {
            if (rawTextTag !== undefined)
              html += escapeRawText(slot.text, rawTextTag)
            else
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
          if (!hasSiblings) {
            ops.push(`${use('insert')}(${elVar}, () => ${renderedCode}, null, null);`)
          }
          else if (isLast) {
            const startVar = requestChild(elVar, domIndex)
            html += '<!--k[-->'
            domIndex++
            ops.push(`${use('insert')}(${elVar}, () => ${renderedCode}, null, ${startVar});`)
          }
          else {
            const startVar = requestChild(elVar, domIndex)
            const endVar = requestChild(elVar, domIndex + 1)
            html += '<!--k[--><!--k]-->'
            addRangeSlot(elVar, domIndex + 1)
            domIndex += 2
            ops.push(`${use('insert')}(${elVar}, () => ${renderedCode}, ${endVar}, ${startVar});`)
          }
          hadVariableRange = true
          continue
        }

        if (slot.kind === 'loop') {
          const { match } = slot
          const needsBracket = !isLast || hadVariableRange
          let anchorVar: string
          let skipArg = ''
          if (needsBracket) {
            anchorVar = requestChild(elVar, domIndex)
            html += '<!--k[--><!--k]-->'
            addRangeSlot(elVar, domIndex + 1)
            domIndex += 2
          }
          else {
            anchorVar = 'null'
            if (domIndex > 0)
              skipArg = `, ${domIndex}`
          }

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
            ops.push(`${use('eachStatic')}(${elVar}, ${anchorVar}, ${eachCode}, (${rawParams}) => ${rowBody}${skipArg});`)
            hadVariableRange = true
            continue
          }

          const keyAst = match.isJsxBody ? extractKeyExpr(match.body) : extractBlockKeyExpr(match.body as BlockStatement)
          const rowSig = freshVar('_r')
          const idxSig = idxParam !== undefined ? freshVar('_i') : undefined
          const rowRewrites = new Map(scopeRewrites)
          const keyRewrites = withoutBindings(scopeRewrites, params)
          let keyFn: string

          if (firstParam !== undefined && firstParam.type !== 'Identifier') {
            const patCode = code.slice(firstParam.start, firstParam.end)
            keyFn = keyAst !== undefined
              ? `(${patCode}${idxParam ? `, ${idxParam}` : ''}) => ${compileExpression(keyAst, keyRewrites)}`
              : `(_item) => _item`
            for (const [name, read] of patternReads(firstParam, `${rowSig}.value`, scopeRewrites))
              rowRewrites.set(name, read)
          }
          else {
            const itemParam = firstParam?.type === 'Identifier' ? firstParam.name : '_item'
            keyFn = keyAst !== undefined
              ? `(${itemParam}${idxParam ? `, ${idxParam}` : ''}) => ${compileExpression(keyAst, keyRewrites)}`
              : `(${itemParam}) => ${itemParam}`
            rowRewrites.set(itemParam, `${rowSig}.value`)
          }
          if (idxParam !== undefined && idxSig !== undefined)
            rowRewrites.set(idxParam, `${idxSig}.value`)

          const rowBody = match.isJsxBody ? compileRootJsx(match.body as JSXElement | JSXFragment, rowRewrites) : compileExpression(match.body, rowRewrites)
          const rowParams = idxSig !== undefined ? `${rowSig}, ${idxSig}` : rowSig
          ops.push(`${use('loop')}(${elVar}, ${anchorVar}, () => ${eachCode}, ${keyFn}, (${rowParams}) => ${rowBody}${skipArg});`)
          hadVariableRange = true
          continue
        }

        if (slot.kind === 'and-show') {
          let anchorVar = 'null'
          if (hasSiblings) {
            anchorVar = requestChild(elVar, domIndex)
            html += '<!--k[--><!--k]-->'
            addRangeSlot(elVar, domIndex + 1)
            domIndex += 2
          }
          const whenCode = compileExpression(slot.expr.left, scopeRewrites)
          const trueCode = compileRootJsx(slot.right, scopeRewrites)
          ops.push(`${use('show')}(${elVar}, ${anchorVar}, () => ${whenCode}, () => ${trueCode});`)
          hadVariableRange = true
          continue
        }

        if (slot.kind === 'ternary-show') {
          let anchorVar = 'null'
          if (hasSiblings) {
            anchorVar = requestChild(elVar, domIndex)
            html += '<!--k[--><!--k]-->'
            addRangeSlot(elVar, domIndex + 1)
            domIndex += 2
          }
          const whenCode = compileExpression(slot.expr.test, scopeRewrites)
          const trueCode = isJsxNode(slot.cons)
            ? compileRootJsx(slot.cons, scopeRewrites)
            : compileExpression(slot.cons, scopeRewrites)
          const falseCode = isJsxNode(slot.alt)
            ? compileRootJsx(slot.alt, scopeRewrites)
            : compileExpression(slot.alt, scopeRewrites)
          ops.push(`${use('show')}(${elVar}, ${anchorVar}, () => ${whenCode}, () => ${trueCode}, () => ${falseCode});`)
          hadVariableRange = true
          continue
        }

        // Generic expression slot
        const exprCode = compileExpression(slot.expr, scopeRewrites)
        if (isNodeCapableExpr(slot.expr, jsxNodes)) {
          if (!hasSiblings) {
            ops.push(`${use('insert')}(${elVar}, () => ${exprCode}, null, null);`)
          }
          else if (isLast) {
            const startVar = requestChild(elVar, domIndex)
            html += '<!--k[-->'
            domIndex++
            ops.push(`${use('insert')}(${elVar}, () => ${exprCode}, null, ${startVar});`)
          }
          else {
            const startVar = requestChild(elVar, domIndex)
            const endVar = requestChild(elVar, domIndex + 1)
            html += '<!--k[--><!--k]-->'
            addRangeSlot(elVar, domIndex + 1)
            domIndex += 2
            ops.push(`${use('insert')}(${elVar}, () => ${exprCode}, ${endVar}, ${startVar});`)
          }
          hadVariableRange = true
        }
        else if (!hasSiblings) {
          // Sole dynamic child: 0 comment markers!
          html += ' '
          domIndex++
          const txtVar = freshVar('_txt')
          ops.push(`const ${txtVar} = ${use('firstText')}(${elVar});`)
          ops.push(`${use('effect')}(() => ${use('setText')}(${txtVar}, ${exprCode}));`)
        }
        else {
          // Sibling dynamic text: open comment + optional text (+ closing comment if followed by more siblings)
          const markerVar = requestChild(elVar, domIndex)
          if (isLast) {
            html += '<!----> '
            domIndex += 2
          }
          else {
            html += '<!----> <!---->'
            addTextSlot(elVar, domIndex + 1)
            domIndex += 3
          }
          const txtVar = freshVar('_txt')
          ops.push(`const ${txtVar} = ${use('textAfter')}(${markerVar});`)
          ops.push(`${use('effect')}(() => ${use('setText')}(${txtVar}, ${exprCode}));`)
        }
        }
      }
      finally {
        svgDepth = prevSvgDepth
      }

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

  function compileRootJsx(node: JSXElement | JSXFragment, scopeRewrites: ReadonlyMap<string, string>): string {
    if (node.type === 'JSXFragment') {
      const meaningful = filterMeaningfulChildren(node.children)
      if (meaningful.length === 0)
        return 'null'
      if (meaningful.length === 1) {
        const only = meaningful[0]!
        if (isJsxNode(only))
          return compileRootJsx(only, scopeRewrites)
        if (only.type === 'JSXText')
          return `${use('fragText')}(${JSON.stringify(decodeHtmlEntities(cleanJsxText(only.value)))})`
        if (only.type === 'JSXExpressionContainer' && only.expression.type !== 'JSXEmptyExpression')
          return `${use('fragInsert')}(() => (${compileExpression(only.expression, scopeRewrites)}))`
      }

      // Each child claims its own SSR nodes while hydrating, so the siblings after a dynamic one keep theirs (#3596).
      const items = meaningful.map((child) => {
        if (isJsxNode(child)) {
          // The server brackets a component or a nested fragment among siblings, so it claims that range like an expression.
          const inPlace = child.type === 'JSXElement' && !isComponentTag(jsxTagName(child.openingElement.name))
          return inPlace ? compileRootJsx(child, scopeRewrites) : `${use('fragInsert')}(() => ${compileRootJsx(child, scopeRewrites)})`
        }
        if (child.type === 'JSXText')
          return `${use('fragText')}(${JSON.stringify(decodeHtmlEntities(cleanJsxText(child.value)))})`
        if (child.type === 'JSXExpressionContainer' && child.expression.type !== 'JSXEmptyExpression') {
          const exprCode = compileExpression(child.expression, scopeRewrites)
          if (isNodeCapableExpr(child.expression, jsxNodes))
            return `${use('fragInsert')}(() => (${exprCode}))`
          return `(() => { const _t = ${use('fragText')}("", true); ${use('effect')}(() => ${use('setText')}(_t, (${exprCode}))); return _t; })()`
        }
        return 'document.createTextNode("")'
      })
      return `${use('frag')}(${items.join(', ')})`
    }

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

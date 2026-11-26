// Kay v2 SSR compiler: compiles TSX directly to flat string concatenation, inline for-loops,
// static attribute literal folding, compile-time static island props, and shared balanced hydration markers.

import type {
  JSXChild,
  JSXElement,
  JSXFragment,
  Node,
} from 'oxc-parser'
import type { ModuleAnalysis } from './analyze'
import type { SelectValueBinding } from './ssr-helpers'
import { analyzeModule, parseTsx } from './analyze'
import { walk } from './ast'
import { mistake } from './mistakes'
import { SourceEditor } from './patch'
import {
  cleanJsxText,
  containsJsx,
  createExprContext,
  decodeHtmlEntities,
  escapeRawText,
  escapeStaticAttr,
  escapeStaticText,
  filterMeaningfulChildren,
  isComponentTag,
  isJsxNode,
  jsxTagName,
  planChildSlots,
  RAW_TEXT_ELEMENTS,
  resolveKayTag,
  unwrapParens,
  VOID_ELEMENTS,
} from './shared'
import {
  emitSsrElementAttrs,
  precomputeSsrSubtreeFlags,
  serializeComponentProps,
  StringParts,
} from './ssr-helpers'

export interface IslandBinding {
  id: string
  chunk: string
  defaultHydrate?: string | undefined
}

export interface CompileSsrOptions {
  islands?: ReadonlyMap<string, IslandBinding> | undefined
  isIsland?: boolean | undefined
  emitMarkers?: boolean | undefined
  analysis?: ModuleAnalysis | undefined
}

export interface CompileResult {
  code: string
  analysis: ModuleAnalysis
}

export function compileSsr(filename: string, code: string, options: CompileSsrOptions = {}): CompileResult {
  const program = options.analysis?.program ?? parseTsx(filename, code)
  const analysis = options.analysis ?? analyzeModule(filename, code, program)

  if (!analysis.hasJsx)
    return { code, analysis }

  const editor = new SourceEditor(code)
  const used = new Set<string>()
  let loopCounter = 0
  let activeSelectValue: SelectValueBinding | undefined

  const use = (name: string): string => {
    used.add(name)
    return `__${name}`
  }

  const islands = options.islands
  const emitMarkers = options.emitMarkers ?? options.isIsland ?? analysis.isInteractive
  const jsxNodes = analysis.jsxNodes
  const exprContext = createExprContext(program, jsxNodes)
  const { directAwaitNodes, dynamicChildNodes } = precomputeSsrSubtreeFlags(program)

  function compileSubExpression(node: Node): string {
    if (!containsJsx(node, jsxNodes))
      return code.slice(node.start, node.end)

    const sub = new SourceEditor(code.slice(node.start, node.end))
    const offset = node.start
    walk(node, (child) => {
      if (isJsxNode(child)) {
        sub.replace(child.start - offset, child.end - offset, compileRootJsx(child))
        return false
      }
      return undefined
    })
    return sub.toString()
  }

  function compileChildrenListToStringExpr(children: readonly JSXChild[], slotMarkers = emitMarkers, inFragment = false, rawTextTag?: 'style' | 'script'): string {
    const bufVar = `_o${loopCounter++}`
    const stmts: string[] = []
    const parts = new StringParts()
    const flush = () => {
      if (!parts.isEmpty()) {
        stmts.push(`${bufVar} += ${parts.toExpr()};`)
        parts.clear()
      }
    }
    emitChildrenIntoBuffer(children, bufVar, parts, flush, s => stmts.push(s), rawTextTag, slotMarkers, inFragment)
    if (stmts.length === 0)
      return parts.toExpr()
    flush()
    const hasAwait = children.some(c => directAwaitNodes.has(c))
    if (hasAwait)
      return `(await (async () => { let ${bufVar} = ""; ${stmts.join(' ')} return ${bufVar}; })())`
    return `(() => { let ${bufVar} = ""; ${stmts.join(' ')} return ${bufVar}; })()`
  }

  // Emits JSX directly into a string accumulator variable `_out` (zero closures on nested `.map()` loops!)
  function emitIntoBuffer(node: JSXElement | JSXFragment, bufVar: string, parts: StringParts, flushParts: () => void, pushStmt: (stmt: string) => void): void {
    if (node.type === 'JSXFragment') {
      emitChildrenIntoBuffer(node.children, bufVar, parts, flushParts, pushStmt, undefined, emitMarkers, true)
      return
    }

    const tag = jsxTagName(node.openingElement.name)
    if (isComponentTag(tag)) {
      emitComponent(node, tag, parts)
      return
    }

    parts.pushStatic(`<${tag}`)
    const isTextarea = tag === 'textarea'
    const isSelect = tag === 'select'
    const { innerHtmlExpr, textareaValue, nextSelectValue } = emitSsrElementAttrs({
      node,
      tag,
      parts,
      activeSelectValue,
      flushParts,
      pushStmt,
      nextId: () => loopCounter++,
      use,
      compileSubExpression,
    })

    parts.pushStatic('>')
    if (VOID_ELEMENTS.has(tag))
      return

    const prevSelectValue = activeSelectValue
    if (isSelect)
      activeSelectValue = nextSelectValue

    try {
      if (innerHtmlExpr !== undefined) {
        parts.pushExpr(innerHtmlExpr)
      }
      else if (isTextarea && textareaValue !== undefined && filterMeaningfulChildren(node.children).length === 0) {
        if (textareaValue.staticText !== undefined)
          parts.pushStatic(escapeStaticText(textareaValue.staticText))
        else if (textareaValue.expr !== undefined)
          parts.pushExpr(`${use('esc')}(${textareaValue.expr})`)
      }
      else if (tag === 'style') {
        const styleExpr = compileChildrenListToStringExpr(node.children, false, false, 'style')
        if (styleExpr !== '""')
          parts.pushExpr(`${use('ssrStyleBlock')}(${styleExpr})`)
      }
      else {
        emitChildrenIntoBuffer(node.children, bufVar, parts, flushParts, pushStmt, RAW_TEXT_ELEMENTS.has(tag) ? tag as 'style' | 'script' : undefined)
      }
    }
    finally {
      activeSelectValue = prevSelectValue
    }
    parts.pushStatic(`</${tag}>`)
  }

  function emitChildrenIntoBuffer(
    children: readonly JSXChild[],
    bufVar: string,
    parts: StringParts,
    flushParts: () => void,
    pushStmt: (stmt: string) => void,
    rawTextTag?: 'style' | 'script',
    slotMarkers = emitMarkers,
    inFragment = false,
  ): void {
    const planned = planChildSlots(children, { jsxNodes, exprContext, emitMarkers: slotMarkers, inFragment })

    for (const { child, slot, open, close } of planned) {
      if (slot.kind === 'static-text') {
        if (rawTextTag !== undefined)
          parts.pushStatic(escapeRawText(slot.text, rawTextTag))
        else
          parts.pushStatic(escapeStaticText(slot.fromLiteral ? slot.text : decodeHtmlEntities(slot.text)))
        continue
      }

      if (rawTextTag !== undefined) {
        if (child.type === 'JSXExpressionContainer' && child.expression.type !== 'JSXEmptyExpression') {
          const expr = child.expression
          if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0 && expr.quasis.length === 1) {
            const cooked = expr.quasis[0]?.value.cooked
            if (typeof cooked === 'string') {
              parts.pushStatic(escapeRawText(cooked, rawTextTag))
              continue
            }
          }
          parts.pushExpr(`${use('ssrRawText')}(${JSON.stringify(rawTextTag)}, ${compileSubExpression(expr)})`)
          continue
        }
      }

      if (slot.kind === 'element') {
        emitIntoBuffer(slot.node, bufVar, parts, flushParts, pushStmt)
        continue
      }

      if (open !== '')
        parts.pushStatic(open)

      if (slot.kind === 'component' || slot.kind === 'fragment') {
        emitIntoBuffer(slot.node, bufVar, parts, flushParts, pushStmt)
      }
      else if (slot.kind === 'loop') {
        const { match } = slot
        const itemParam = match.params[0]?.type === 'Identifier' ? match.params[0].name : undefined
        const idxParam = match.params[1]?.type === 'Identifier' ? match.params[1].name : undefined

        if (match.isJsxBody && itemParam !== undefined && match.params.length <= 2 && (match.params.length < 2 || idxParam !== undefined)) {
          flushParts()
          const n = loopCounter++
          const arrVar = `_a${n}`
          const idxVar = idxParam ?? `_i${n}`
          const innerStmts: string[] = []
          const innerParts = new StringParts()
          const flushInner = () => {
            if (!innerParts.isEmpty()) {
              innerStmts.push(`${bufVar} += ${innerParts.toExpr()};`)
              innerParts.clear()
            }
          }
          emitIntoBuffer(match.body as JSXElement | JSXFragment, bufVar, innerParts, flushInner, s => innerStmts.push(s))
          flushInner()

          const target = compileSubExpression(match.target)
          pushStmt(
            `const ${arrVar} = ${target}; if (${arrVar}) for (let ${idxVar} = 0; ${idxVar} < ${arrVar}.length; ${idxVar}++) { const ${itemParam} = ${arrVar}[${idxVar}]; ${innerStmts.join(' ')} }`,
          )
        }
        else if (match.isJsxBody) {
          const target = compileSubExpression(match.target)
          const params = match.params.map(p => code.slice(p.start, p.end)).join(', ')
          parts.pushExpr(`${use('ssrLoop')}(${target}, (${params}) => ${compileJsxToStringExpr(match.body as JSXElement | JSXFragment)})`)
        }
        else {
          parts.pushExpr(`${use('esc')}(${compileSubExpression(match.call)})`)
        }
      }
      else if (slot.kind === 'and-show') {
        const left = compileSubExpression(slot.expr.left)
        const right = compileJsxToStringExpr(slot.right)
        parts.pushExpr(`((${left}) ? (${right}) : "")`)
      }
      else if (slot.kind === 'ternary-show') {
        const test = compileSubExpression(slot.expr.test)
        const cons = compileExpressionAsString(slot.cons)
        const alt = compileExpressionAsString(slot.alt)
        parts.pushExpr(`((${test}) ? (${cons}) : (${alt}))`)
      }
      else {
        parts.pushExpr(`${use('esc')}(${compileSubExpression(slot.expr)})`)
      }

      if (close !== '')
        parts.pushStatic(close)
    }
  }

  function compileExpressionAsString(expr: Node): string {
    if (isJsxNode(expr))
      return compileJsxToStringExpr(expr)
    if (expr.type === 'LogicalExpression' && expr.operator === '&&') {
      const right = unwrapParens(expr.right)
      if (isJsxNode(right))
        return `((${compileSubExpression(expr.left)}) ? (${compileJsxToStringExpr(right)}) : "")`
    }
    if (expr.type === 'ConditionalExpression') {
      const consNode = unwrapParens(expr.consequent)
      const altNode = unwrapParens(expr.alternate)
      if (isJsxNode(consNode) || isJsxNode(altNode))
        return `((${compileSubExpression(expr.test)}) ? (${compileExpressionAsString(consNode)}) : (${compileExpressionAsString(altNode)}))`
    }
    return `${use('esc')}(${compileSubExpression(expr)})`
  }

  function emitComponent(node: JSXElement, tag: string, parts: StringParts): void {
    const { propEntries, allStaticProps, staticPropsObj, hydrateExpr, staticHydrate } = serializeComponentProps(node.openingElement.attributes, compileSubExpression)
    const childNodes = node.children
    const meaningfulChildren = filterMeaningfulChildren(childNodes)
    const hasChildren = meaningfulChildren.length > 0

    // Special case: <Suspense fallback={...}><AsyncComp .../></Suspense> (including aliased/namespaced imports) passes the raw component call/Promise!
    if (resolveKayTag(tag, analysis.imports) === 'Suspense') {
      if (meaningfulChildren.length === 1) {
        const only = meaningfulChildren[0]!
        if (only.type === 'JSXElement' && isComponentTag(jsxTagName(only.openingElement.name))) {
          const innerTag = jsxTagName(only.openingElement.name)
          const inner = serializeComponentProps(only.openingElement.attributes, compileSubExpression)
          const innerMeaningful = filterMeaningfulChildren(only.children)
          if (innerMeaningful.length > 0) {
            const innerChildExpr = compileChildrenListToStringExpr(only.children)
            inner.propEntries.push(`children: ${use('raw')}(${innerChildExpr})`)
          }
          const innerObj = inner.propEntries.length > 0 ? `{ ${inner.propEntries.join(', ')} }` : '{}'
          propEntries.push(`children: ${innerTag}(${innerObj})`)
        }
        else if (only.type === 'JSXExpressionContainer' && only.expression.type !== 'JSXEmptyExpression') {
          propEntries.push(`children: ${compileSubExpression(only.expression)}`)
        }
        else if (only.type === 'JSXText') {
          propEntries.push(`children: ${JSON.stringify(decodeHtmlEntities(cleanJsxText(only.value)))}`)
        }
        else if (isJsxNode(only)) {
          propEntries.push(`children: ${use('raw')}(${compileJsxToStringExpr(only)})`)
        }
      }
      const propsObj = propEntries.length > 0 ? `{ ${propEntries.join(', ')} }` : '{}'
      parts.pushExpr(`${use('ssrChild')}(${tag}(${propsObj}))`)
      return
    }

    const islandInfo = islands?.get(tag)
    if (islandInfo === undefined && islands !== undefined && hydrateExpr !== undefined)
      throw mistake(`$hydrate on <${tag}>`, filename, `${tag} is not an island, so it never hydrates; drop $hydrate, or give ${tag} state or handlers`)

    const childrenHaveAwait = hasChildren && childNodes.some(c => directAwaitNodes.has(c))
    const childMarkers = islandInfo === undefined && emitMarkers
    const childExpr = hasChildren ? compileChildrenListToStringExpr(childNodes, childMarkers, childMarkers && meaningfulChildren.length > 1) : '""'

    if (islandInfo !== undefined) {
      const propsCode = `{ ${propEntries.join(', ')} }`
      // The server children an island is handed render before it, outside its contexts and ids, as the browser never re-renders them.
      const slotVar = hasChildren ? `_c${loopCounter++}` : undefined
      const slotProp = slotVar === undefined ? '' : `children: ${slotVar}.prop`
      const callPropsCode = slotVar === undefined ? propsCode : `{ ${[...propEntries, slotProp].join(', ')} }`
      const withSlot = (expr: string): string => slotVar === undefined ? expr : `((${slotVar}) => ${expr})(${use('ssrSlot')}(${childExpr}))`
      const slotArg = slotVar === undefined ? '' : `, ${slotVar}`
      const resolvedHydrate = staticHydrate ?? (hydrateExpr === undefined ? islandInfo.defaultHydrate : undefined)
      const safeStaticProps = allStaticProps
        && !Object.hasOwn(staticPropsObj, '__k')
        && !Object.values(staticPropsObj).some(v => Object.is(v, -0))

      // Compile-time static island props fast path (only when not inside an island-reachable component and children don't contain direct `await`):
      // 0 JSON.stringify / Object.keys / escAttr at runtime, while still recording rendered islands & island ID scope!
      if (!emitMarkers && !childrenHaveAwait && safeStaticProps && (hydrateExpr === undefined || staticHydrate !== undefined)) {
        const pAttr = Object.keys(staticPropsObj).length > 0
          ? ` p="${escapeStaticAttr(JSON.stringify(staticPropsObj))}"`
          : ''
        const hAttr = resolvedHydrate !== undefined && resolvedHydrate !== 'load'
          ? ` h="${escapeStaticAttr(resolvedHydrate)}"`
          : ''
        const openTag = `<kay-island c="${escapeStaticAttr(islandInfo.chunk)}"${pAttr}${hAttr}>`
        const hydrateArg = resolvedHydrate !== undefined ? JSON.stringify(resolvedHydrate) : 'undefined'
        const renderArg = resolvedHydrate === 'client'
          ? 'undefined'
          : `() => ${use('ssrChild')}(${tag}(${callPropsCode}))`
        const expr = `${use('ssrIslandStatic')}(${JSON.stringify(islandInfo.chunk)}, ${JSON.stringify(openTag)}, ${renderArg}, ${hydrateArg}, ${JSON.stringify(tag)}${slotArg})`
        parts.pushExpr(withSlot(expr))
        return
      }

      const hydrateArg = hydrateExpr ?? (islandInfo.defaultHydrate !== undefined ? JSON.stringify(islandInfo.defaultHydrate) : 'undefined')
      if (!childrenHaveAwait && safeStaticProps && (hydrateExpr === undefined || staticHydrate !== undefined)) {
        parts.pushExpr(withSlot(`${use('ssrIsland')}(${JSON.stringify(islandInfo.chunk)}, () => ${use('ssrChild')}(${tag}(${callPropsCode})), ${propsCode}, ${hydrateArg}, false, ${JSON.stringify(tag)}${slotArg})`))
        return
      }

      // Hoist dynamic island props / awaited children into a single binding so expressions evaluate once!
      const pVar = `_p${loopCounter++}`
      const argNames = [pVar]
      const argExprs = [propsCode]
      let callArg = pVar
      if (slotVar !== undefined) {
        argNames.push(slotVar)
        argExprs.push(`${use('ssrSlot')}(${childExpr})`)
        callArg = `{ ...${pVar}, ${slotProp} }`
      }
      let hArg = hydrateArg
      if (hydrateExpr !== undefined && staticHydrate === undefined) {
        const hVar = `_h${loopCounter++}`
        argNames.push(hVar)
        argExprs.push(hydrateExpr)
        hArg = hVar
      }
      parts.pushExpr(
        `((${argNames.join(', ')}) => ${use('ssrIsland')}(${JSON.stringify(islandInfo.chunk)}, () => ${use('ssrChild')}(${tag}(${callArg})), ${pVar}, ${hArg}, false, ${JSON.stringify(tag)}${slotArg}))(${argExprs.join(', ')})`,
      )
      return
    }

    const childrenHaveDynamic = hasChildren && childNodes.some(c => dynamicChildNodes.has(c))

    // Lazy memoized getter for non-async dynamic/component children so Providers & context components run before their children!
    if (childrenHaveDynamic && !childrenHaveAwait) {
      const cVar = `_c${loopCounter++}`
      const propsWithGetter = [...propEntries, `get children() { return ${cVar} === undefined ? (${cVar} = ${use('raw')}(${childExpr})) : ${cVar} }`].join(', ')
      parts.pushExpr(`${use('ssrChild')}(${tag}((() => { let ${cVar}; return { ${propsWithGetter} }; })()))`)
      return
    }

    if (hasChildren)
      propEntries.push(`children: ${use('raw')}(${childExpr})`)

    const propsObj = propEntries.length > 0 ? `{ ${propEntries.join(', ')} }` : '{}'
    parts.pushExpr(`${use('ssrChild')}(${tag}(${propsObj}))`)
  }

  function compileJsxToStringExpr(node: JSXElement | JSXFragment): string {
    const bufVar = `_o${loopCounter++}`
    const stmts: string[] = []
    const parts = new StringParts()

    const flush = () => {
      if (!parts.isEmpty()) {
        stmts.push(`${bufVar} += ${parts.toExpr()};`)
        parts.clear()
      }
    }

    emitIntoBuffer(node, bufVar, parts, flush, s => stmts.push(s))

    // If no inline `for` statements were emitted, stay a pure flat concatenation expression!
    if (stmts.length === 0)
      return parts.toExpr()

    flush()
    if (directAwaitNodes.has(node))
      return `(await (async () => { let ${bufVar} = ""; ${stmts.join(' ')} return ${bufVar}; })())`
    return `(() => { let ${bufVar} = ""; ${stmts.join(' ')} return ${bufVar}; })()`
  }

  function compileRootJsx(node: JSXElement | JSXFragment): string {
    return `${use('raw')}(${compileJsxToStringExpr(node)})`
  }

  walk(program, (node) => {
    if (isJsxNode(node)) {
      editor.replace(node.start, node.end, compileRootJsx(node))
      return false
    }
    return undefined
  })

  if (used.size > 0) {
    const specifiers = [...used].sort().map(name => `${name} as __${name}`).join(', ')
    editor.prepend(`import { ${specifiers} } from '@kayjs/kay/internal/ssr';\n`)
  }

  return { code: editor.toString(), analysis }
}

// Kay v2 SSR compiler: compiles TSX directly to flat string concatenation, inline for-loops,
// static attribute literal folding, compile-time static island props, and shared balanced hydration markers.

import type {
  JSXAttributeItem,
  JSXChild,
  JSXElement,
  JSXFragment,
  Node,
} from 'oxc-parser'
import type { ModuleAnalysis } from './analyze'
import { analyzeModule, parseTsx } from './analyze'
import { walk } from './ast'
import { mistake } from './mistakes'
import { SourceEditor } from './patch'
import {
  classifyJsxChild,
  containsJsx,
  decodeHtmlEntities,
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
  unwrapParens,
  VOID_ELEMENTS,
} from './shared'

function containsDirectAwait(root: Node): boolean {
  let found = false
  walk(root, (child) => {
    if (found)
      return false
    if (child !== root && (
      child.type === 'FunctionDeclaration'
      || child.type === 'FunctionExpression'
      || child.type === 'ArrowFunctionExpression'
    )) {
      return false
    }
    if (child.type === 'AwaitExpression') {
      found = true
      return false
    }
    return undefined
  })
  return found
}

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

class StringParts {
  #parts: { static: boolean, value: string }[] = []

  pushStatic(str: string): void {
    if (str === '')
      return
    const last = this.#parts[this.#parts.length - 1]
    if (last !== undefined && last.static)
      last.value += str
    else
      this.#parts.push({ static: true, value: str })
  }

  pushExpr(code: string): void {
    this.#parts.push({ static: false, value: code })
  }

  isEmpty(): boolean {
    return this.#parts.length === 0
  }

  clear(): void {
    this.#parts.length = 0
  }

  toExpr(): string {
    if (this.#parts.length === 0)
      return '""'
    return this.#parts
      .map(p => (p.static ? JSON.stringify(p.value) : `(${p.value})`))
      .join(' + ')
  }
}

function isStaticNullish(node: Node): boolean {
  return (node.type === 'Identifier' && node.name === 'undefined')
    || (node.type === 'Literal' && node.value === null)
}

function formatStaticAttrBranch(attrName: string, node: Node): string | undefined {
  if (isBlockedAttr(attrName))
    return '""'
  if (isStaticNullish(node))
    return '""'
  if (node.type === 'Literal') {
    if (typeof node.value === 'boolean') {
      if (isStringBoolAttr(attrName))
        return JSON.stringify(` ${attrName}="${node.value ? 'true' : 'false'}"`)
      return node.value ? JSON.stringify(` ${attrName}`) : '""'
    }
    if (typeof node.value === 'string' || typeof node.value === 'number') {
      if (isUnsafeUrlAttr(attrName, node.value))
        return '""'
      return JSON.stringify(` ${attrName}="${escapeStaticAttr(String(node.value))}"`)
    }
  }
  return undefined
}

export function compileSsr(filename: string, code: string, options: CompileSsrOptions = {}): CompileResult {
  const program = options.analysis?.program ?? parseTsx(filename, code)
  const analysis = options.analysis ?? analyzeModule(filename, code, program)

  if (!analysis.hasJsx)
    return { code, analysis }

  const editor = new SourceEditor(code)
  const used = new Set<string>()
  let loopCounter = 0

  const use = (name: string): string => {
    used.add(name)
    return `__${name}`
  }

  const islands = options.islands
  const emitMarkers = options.emitMarkers ?? options.isIsland ?? analysis.isInteractive
  const jsxNodes = analysis.jsxNodes

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

  function serializeComponentProps(attrs: readonly JSXAttributeItem[]): {
    propEntries: string[]
    allStaticProps: boolean
    staticPropsObj: Record<string, unknown>
    hydrateExpr: string | undefined
    staticHydrate: string | undefined
  } {
    const propEntries: string[] = []
    let allStaticProps = true
    const staticPropsObj: Record<string, unknown> = {}
    let hydrateExpr: string | undefined
    let staticHydrate: string | undefined

    for (const attr of attrs) {
      if (attr.type === 'JSXSpreadAttribute') {
        allStaticProps = false
        propEntries.push(`...(${compileSubExpression(attr.argument)})`)
        continue
      }
      const name = jsxTagName(attr.name)
      if (name === 'key')
        continue
      if (name === '$hydrate') {
        if (attr.value?.type === 'Literal' && typeof attr.value.value === 'string') {
          staticHydrate = attr.value.value
          hydrateExpr = JSON.stringify(attr.value.value)
        }
        else if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
          hydrateExpr = compileSubExpression(attr.value.expression)
        }
        continue
      }

      const propKey = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
      if (attr.value === null) {
        propEntries.push(`${propKey}: true`)
        staticPropsObj[name] = true
      }
      else if (attr.value.type === 'Literal') {
        propEntries.push(`${propKey}: ${JSON.stringify(attr.value.value)}`)
        staticPropsObj[name] = attr.value.value
      }
      else if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
        const expr = attr.value.expression
        const lit = staticLiteral(expr)
        if (lit.ok)
          staticPropsObj[name] = lit.value
        else
          allStaticProps = false
        propEntries.push(`${propKey}: ${compileSubExpression(expr)}`)
      }
    }

    return { propEntries, allStaticProps, staticPropsObj, hydrateExpr, staticHydrate }
  }

  function compileChildrenListToStringExpr(children: readonly JSXChild[], slotMarkers = emitMarkers): string {
    const bufVar = `_o${loopCounter++}`
    const stmts: string[] = []
    const parts = new StringParts()
    const flush = () => {
      if (!parts.isEmpty()) {
        stmts.push(`${bufVar} += ${parts.toExpr()};`)
        parts.clear()
      }
    }
    emitChildrenIntoBuffer(children, bufVar, parts, flush, s => stmts.push(s), undefined, slotMarkers)
    if (stmts.length === 0)
      return parts.toExpr()
    flush()
    const hasAwait = children.some(c => containsDirectAwait(c))
    if (hasAwait)
      return `(await (async () => { let ${bufVar} = ""; ${stmts.join(' ')} return ${bufVar}; })())`
    return `(() => { let ${bufVar} = ""; ${stmts.join(' ')} return ${bufVar}; })()`
  }

  // Emits JSX directly into a string accumulator variable `_out` (zero closures on nested `.map()` loops!)
  function emitIntoBuffer(node: JSXElement | JSXFragment, bufVar: string, parts: StringParts, flushParts: () => void, pushStmt: (stmt: string) => void): void {
    if (node.type === 'JSXFragment') {
      emitChildrenIntoBuffer(node.children, bufVar, parts, flushParts, pushStmt)
      return
    }

    const tag = jsxTagName(node.openingElement.name)
    if (isComponentTag(tag)) {
      emitComponent(node, tag, parts)
      return
    }

    parts.pushStatic(`<${tag}`)
    let innerHtmlExpr: string | undefined

    for (const attr of node.openingElement.attributes) {
      if (attr.type === 'JSXSpreadAttribute') {
        parts.pushExpr(`${use('ssrSpread')}(${compileSubExpression(attr.argument)})`)
        continue
      }
      const rawName = jsxTagName(attr.name)
      if (rawName === 'key' || rawName === 'ref' || rawName === '$hydrate' || EVENT_ATTR.test(rawName))
        continue
      if (rawName === 'innerHTML') {
        if (attr.value?.type === 'Literal')
          innerHtmlExpr = JSON.stringify(String(attr.value.value))
        else if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression')
          innerHtmlExpr = `${use('ssrRaw')}(${compileSubExpression(attr.value.expression)})`
        continue
      }

      const name = rawName === 'className' ? 'class' : rawName === 'htmlFor' ? 'for' : rawName
      if (isBlockedAttr(name))
        continue

      if (attr.value === null) {
        parts.pushStatic(isStringBoolAttr(name) ? ` ${name}="true"` : ` ${name}`)
      }
      else if (attr.value.type === 'Literal') {
        if (!isUnsafeUrlAttr(name, attr.value.value))
          parts.pushStatic(` ${name}="${escapeStaticAttr(String(attr.value.value))}"`)
      }
      else if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
        const expr = attr.value.expression

        // Fold static ternary attribute branches (`class={cond ? 'stock out' : 'stock in'}`) with 0 runtime escaping!
        if (name !== 'style' && expr.type === 'ConditionalExpression') {
          const cons = formatStaticAttrBranch(name, expr.consequent)
          const alt = formatStaticAttrBranch(name, expr.alternate)
          if (cons !== undefined && alt !== undefined) {
            parts.pushExpr(`${compileSubExpression(expr.test)} ? ${cons} : ${alt}`)
            continue
          }
        }

        const exprCode = compileSubExpression(expr)
        if (name === 'style')
          parts.pushExpr(`${use('ssrStyle')}(${exprCode})`)
        else
          parts.pushExpr(`${use('ssrAttr')}(${JSON.stringify(name)}, ${exprCode})`)
      }
    }

    parts.pushStatic('>')
    if (VOID_ELEMENTS.has(tag))
      return

    if (innerHtmlExpr !== undefined)
      parts.pushExpr(innerHtmlExpr)
    else
      emitChildrenIntoBuffer(node.children, bufVar, parts, flushParts, pushStmt, RAW_TEXT_ELEMENTS.has(tag) ? tag as 'style' | 'script' : undefined)
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
  ): void {
    const meaningful = filterMeaningfulChildren(children)
    const slots = meaningful.map(c => ({ child: c, slot: classifyJsxChild(c, jsxNodes) })).filter(s => s.slot !== undefined)
    const hasSiblings = slots.length > 1
    let hadVariableRange = false

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!.slot!
      const isLast = i === slots.length - 1

      if (slot.kind === 'static-text') {
        if (rawTextTag !== undefined)
          parts.pushStatic(escapeRawText(slot.text, rawTextTag))
        else
          parts.pushStatic(escapeStaticText(slot.fromLiteral ? slot.text : decodeHtmlEntities(slot.text)))
        continue
      }

      if (rawTextTag !== undefined) {
        const rawChild = slots[i]!.child
        if (rawChild.type === 'JSXExpressionContainer' && rawChild.expression.type !== 'JSXEmptyExpression') {
          const expr = rawChild.expression
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

      if (slot.kind === 'component' || slot.kind === 'fragment') {
        if (slotMarkers && hasSiblings) {
          parts.pushStatic('<!--k[-->')
          emitIntoBuffer(slot.node, bufVar, parts, flushParts, pushStmt)
          if (!isLast)
            parts.pushStatic('<!--k]-->')
        }
        else {
          emitIntoBuffer(slot.node, bufVar, parts, flushParts, pushStmt)
        }
        hadVariableRange = true
        continue
      }

      if (slot.kind === 'loop') {
        const { match } = slot
        const needsBracket = slotMarkers && (!isLast || hadVariableRange)
        if (needsBracket)
          parts.pushStatic('<!--k[-->')

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

        if (needsBracket)
          parts.pushStatic('<!--k]-->')
        hadVariableRange = true
        continue
      }

      if (slot.kind === 'and-show') {
        const left = compileSubExpression(slot.expr.left)
        const right = compileJsxToStringExpr(slot.right)
        if (slotMarkers && hasSiblings) {
          parts.pushStatic('<!--k[-->')
          parts.pushExpr(`((${left}) ? (${right}) : "")`)
          parts.pushStatic('<!--k]-->')
        }
        else {
          parts.pushExpr(`((${left}) ? (${right}) : "")`)
        }
        hadVariableRange = true
        continue
      }

      if (slot.kind === 'ternary-show') {
        const test = compileSubExpression(slot.expr.test)
        const cons = compileExpressionAsString(slot.cons)
        const alt = compileExpressionAsString(slot.alt)
        if (slotMarkers && hasSiblings) {
          parts.pushStatic('<!--k[-->')
          parts.pushExpr(`((${test}) ? (${cons}) : (${alt}))`)
          parts.pushStatic('<!--k]-->')
        }
        else {
          parts.pushExpr(`((${test}) ? (${cons}) : (${alt}))`)
        }
        hadVariableRange = true
        continue
      }

      // Generic expression slot
      const exprCode = compileSubExpression(slot.expr)
      const rendered = `${use('esc')}(${exprCode})`
      if (isNodeCapableExpr(slot.expr, jsxNodes)) {
        if (slotMarkers && hasSiblings) {
          parts.pushStatic('<!--k[-->')
          parts.pushExpr(rendered)
          if (!isLast)
            parts.pushStatic('<!--k]-->')
        }
        else {
          parts.pushExpr(rendered)
        }
        hadVariableRange = true
      }
      else if (slotMarkers && hasSiblings) {
        parts.pushStatic('<!---->')
        parts.pushExpr(rendered)
        if (!isLast)
          parts.pushStatic('<!---->')
      }
      else {
        parts.pushExpr(rendered)
      }
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
    const { propEntries, allStaticProps, staticPropsObj, hydrateExpr, staticHydrate } = serializeComponentProps(node.openingElement.attributes)
    const childNodes = node.children
    const meaningfulChildren = filterMeaningfulChildren(childNodes)
    const hasChildren = meaningfulChildren.length > 0

    // Special case: <Suspense fallback={...}><AsyncComp .../></Suspense> passes the raw component call/Promise!
    if (tag === 'Suspense') {
      if (meaningfulChildren.length === 1) {
        const only = meaningfulChildren[0]!
        if (only.type === 'JSXElement' && isComponentTag(jsxTagName(only.openingElement.name))) {
          const innerTag = jsxTagName(only.openingElement.name)
          const inner = serializeComponentProps(only.openingElement.attributes)
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
        else if (isJsxNode(only)) {
          propEntries.push(`children: ${use('raw')}(${compileJsxToStringExpr(only)})`)
        }
      }
      const propsObj = propEntries.length > 0 ? `{ ${propEntries.join(', ')} }` : '{}'
      parts.pushExpr(`${use('ssrChild')}(${tag}(${propsObj}))`)
      return
    }

    const childrenHaveAwait = hasChildren && childNodes.some(c => containsDirectAwait(c))
    const childExpr = hasChildren ? compileChildrenListToStringExpr(childNodes, false) : '""'

    const islandInfo = islands?.get(tag)
    if (islandInfo === undefined && islands !== undefined && hydrateExpr !== undefined)
      throw mistake(`$hydrate on <${tag}>`, filename, `${tag} is not an island, so it never hydrates; drop $hydrate, or give ${tag} state or handlers`)

    if (islandInfo !== undefined) {
      const propsCode = `{ ${propEntries.join(', ')} }`
      // The server children an island is handed render before it, outside its contexts and ids, as the browser never re-renders them.
      const slotVar = hasChildren ? `_c${loopCounter++}` : undefined
      const slotProp = slotVar === undefined ? '' : `children: ${use('raw')}("<kay-slot>" + ${slotVar} + "</kay-slot>")`
      const callPropsCode = slotVar === undefined ? propsCode : `{ ${[...propEntries, slotProp].join(', ')} }`
      const withSlot = (expr: string): string => slotVar === undefined ? expr : `((${slotVar}) => ${expr})(${childExpr})`
      const resolvedHydrate = staticHydrate ?? (hydrateExpr === undefined ? islandInfo.defaultHydrate : undefined)

      // Compile-time static island props fast path (only when not inside an island-reachable component and children don't contain direct `await`):
      // 0 JSON.stringify / Object.keys / escAttr at runtime, while still recording rendered islands & island ID scope!
      if (!emitMarkers && !childrenHaveAwait && allStaticProps && (hydrateExpr === undefined || staticHydrate !== undefined)) {
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
        const expr = `${use('ssrIslandStatic')}(${JSON.stringify(islandInfo.chunk)}, ${JSON.stringify(openTag)}, ${renderArg}, ${hydrateArg}, ${JSON.stringify(tag)})`
        parts.pushExpr(resolvedHydrate === 'client' ? expr : withSlot(expr))
        return
      }

      const hydrateArg = hydrateExpr ?? (islandInfo.defaultHydrate !== undefined ? JSON.stringify(islandInfo.defaultHydrate) : 'undefined')
      if (!childrenHaveAwait && allStaticProps && (hydrateExpr === undefined || staticHydrate !== undefined)) {
        parts.pushExpr(withSlot(`${use('ssrIsland')}(${JSON.stringify(islandInfo.chunk)}, () => ${use('ssrChild')}(${tag}(${callPropsCode})), ${propsCode}, ${hydrateArg}, false, ${JSON.stringify(tag)})`))
        return
      }

      // Hoist dynamic island props / awaited children into a single binding so expressions evaluate once!
      const pVar = `_p${loopCounter++}`
      const argNames = [pVar]
      const argExprs = [propsCode]
      let callArg = pVar
      if (slotVar !== undefined) {
        argNames.push(slotVar)
        argExprs.push(childExpr)
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
        `((${argNames.join(', ')}) => ${use('ssrIsland')}(${JSON.stringify(islandInfo.chunk)}, () => ${use('ssrChild')}(${tag}(${callArg})), ${pVar}, ${hArg}, false, ${JSON.stringify(tag)}))(${argExprs.join(', ')})`,
      )
      return
    }

    const childrenHaveDynamic = hasChildren && childNodes.some((c) => {
      let dynamic = false
      walk(c, (n) => {
        if (dynamic)
          return false
        if (n.type === 'JSXExpressionContainer' && n.expression.type !== 'JSXEmptyExpression')
          dynamic = true
        else if (n.type === 'JSXElement' && isComponentTag(jsxTagName(n.openingElement.name)))
          dynamic = true
        return undefined
      })
      return dynamic
    })

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
    if (containsDirectAwait(node))
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

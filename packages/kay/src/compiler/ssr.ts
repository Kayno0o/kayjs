// Kay v2 SSR compiler: compiles TSX directly to flat string concatenation, inline for-loops,
// static attribute literal folding, and compile-time static island props.

import type { AstNode, ModuleAnalysis } from './analyze'
import { analyzeModule, parseTsx, walk } from './analyze'
import { SourceEditor } from './patch'

export function escapeStaticText(str: string): string {
  return str.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

const RAW_TEXT_ELEMENTS = new Set(['style', 'script'])
const CLOSE_STYLE_RE = /<\/(style)/gi
const SCRIPT_UNSAFE_RE = /<(\/script|script|!--)/gi

function escapeRawText(str: string, tag: 'style' | 'script'): string {
  if (tag === 'script') {
    return str.replace(SCRIPT_UNSAFE_RE, (_, body: string) =>
      body.charCodeAt(0) === 47 ? `<\\${body}` : `\\u003c${body}`)
  }
  return str.replace(CLOSE_STYLE_RE, '<\\/$1')
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const EVENT_ATTR = /^on[A-Z]/
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href'])
const UNSAFE_URL_RE = /^(?:javascript|vbscript):/i
const STRING_BOOL_ATTRS = new Set(['draggable', 'spellcheck', 'contenteditable'])

function isStringBoolAttr(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('aria-') || STRING_BOOL_ATTRS.has(lower)
}

function isUnsafeUrlAttr(name: string, value: unknown): boolean {
  if (!URL_ATTRS.has(name.toLowerCase()))
    return false
  return UNSAFE_URL_RE.test(String(value).replace(/[\u0000-\u0020]+/g, ''))
}

function containsDirectAwait(root: AstNode): boolean {
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

export function cleanJsxText(raw: string): string {
  if (!raw.includes('\n'))
    return raw
  const lines = raw.split(/\r\n|\n|\r/)
  let out = ''
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.replace(/\t/g, ' ')
    if (i > 0)
      line = line.replace(/^ +/, '')
    if (i < lines.length - 1)
      line = line.replace(/ +$/, '')
    if (line !== '') {
      if (out !== '')
        out += ' '
      out += line
    }
  }
  return out
}

function escapeStaticAttr(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function jsxTagName(node: AstNode): string {
  if (node.type === 'JSXIdentifier')
    return node.name as string
  if (node.type === 'JSXMemberExpression')
    return `${jsxTagName(node.object)}.${node.property.name}`
  if (node.type === 'JSXNamespacedName')
    return `${node.namespace.name}:${node.name.name}`
  return ''
}

function isComponentTag(tag: string): boolean {
  const first = tag.charCodeAt(0)
  return (first >= 65 && first <= 90) || tag.includes('.')
}

function unwrapParens(node: AstNode): AstNode {
  let cur = node
  while (cur.type === 'ParenthesizedExpression')
    cur = cur.expression as AstNode
  return cur
}

function isSimpleLiteral(node: AstNode): { ok: true, value: string | number | boolean | null } | { ok: false } {
  if (node.type === 'Literal') {
    const v = node.value
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)
      return { ok: true, value: v }
  }
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'Literal' && typeof node.argument.value === 'number')
    return { ok: true, value: -node.argument.value }
  return { ok: false }
}

function isStaticNullish(node: AstNode): boolean {
  return (node.type === 'Identifier' && node.name === 'undefined')
    || (node.type === 'Literal' && node.value === null)
}

function formatStaticAttrBranch(attrName: string, node: AstNode): string | undefined {
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

  function compileSubExpression(node: AstNode): string {
    let hasNestedJsx = false
    walk(node, (child) => {
      if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
        hasNestedJsx = true
        return false
      }
      return undefined
    })
    if (!hasNestedJsx)
      return code.slice(node.start, node.end)

    const sub = new SourceEditor(code.slice(node.start, node.end))
    const offset = node.start as number
    walk(node, (child) => {
      if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
        sub.replace(child.start - offset, child.end - offset, compileRootJsx(child))
        return false
      }
      return undefined
    })
    return sub.toString()
  }

  // Emits JSX directly into a string accumulator variable `_out` (zero closures on nested `.map()` loops!)
  function emitIntoBuffer(node: AstNode, bufVar: string, parts: StringParts, flushParts: () => void, pushStmt: (stmt: string) => void): void {
    if (node.type === 'JSXFragment') {
      emitChildrenIntoBuffer(node.children as AstNode[], bufVar, parts, flushParts, pushStmt)
      return
    }

    const tag = jsxTagName(node.openingElement.name)
    if (isComponentTag(tag)) {
      emitComponent(node, tag, parts)
      return
    }

    parts.pushStatic(`<${tag}`)
    let innerHtmlExpr: string | undefined

    for (const attr of node.openingElement.attributes as AstNode[]) {
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
        else if (attr.value?.type === 'JSXExpressionContainer')
          innerHtmlExpr = `${use('ssrRaw')}(${compileSubExpression(attr.value.expression)})`
        continue
      }

      const name = rawName === 'className' ? 'class' : rawName === 'htmlFor' ? 'for' : rawName
      if (attr.value === null) {
        parts.pushStatic(isStringBoolAttr(name) ? ` ${name}="true"` : ` ${name}`)
      }
      else if (attr.value.type === 'Literal') {
        if (!isUnsafeUrlAttr(name, attr.value.value))
          parts.pushStatic(` ${name}="${escapeStaticAttr(String(attr.value.value))}"`)
      }
      else if (attr.value.type === 'JSXExpressionContainer') {
        const expr = attr.value.expression as AstNode

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
      emitChildrenIntoBuffer(node.children as AstNode[], bufVar, parts, flushParts, pushStmt, RAW_TEXT_ELEMENTS.has(tag) ? tag as 'style' | 'script' : undefined)
    parts.pushStatic(`</${tag}>`)
  }

  function emitChildrenIntoBuffer(
    children: AstNode[],
    bufVar: string,
    parts: StringParts,
    flushParts: () => void,
    pushStmt: (stmt: string) => void,
    rawTextTag?: 'style' | 'script',
  ): void {
    const meaningful = children.filter((c) => {
      if (c.type === 'JSXText')
        return cleanJsxText(c.value as string) !== ''
      if (c.type === 'JSXExpressionContainer' && c.expression.type === 'JSXEmptyExpression')
        return false
      return true
    })
    const hasSiblings = meaningful.length > 1

    for (let i = 0; i < meaningful.length; i++) {
      const child = meaningful[i]!
      const isLast = i === meaningful.length - 1
      if (child.type === 'JSXText') {
        const text = cleanJsxText(child.value as string)
        parts.pushStatic(rawTextTag !== undefined ? escapeRawText(text, rawTextTag) : text)
      }
      else if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
        emitIntoBuffer(child, bufVar, parts, flushParts, pushStmt)
      }
      else if (child.type === 'JSXExpressionContainer') {
        const expr = child.expression as AstNode

        // Fold static string literal expressions like `{' '}` or `<style>{':root { ... }'}</style>` directly into static text
        if (expr.type === 'Literal' && typeof expr.value === 'string') {
          parts.pushStatic(rawTextTag !== undefined ? escapeRawText(expr.value, rawTextTag) : escapeStaticText(expr.value))
          continue
        }

        // Fold static no-substitution template literals inside `<style>`/`<script>` directly into raw text
        if (
          rawTextTag !== undefined
          && expr.type === 'TemplateLiteral'
          && (expr.expressions as AstNode[]).length === 0
          && (expr.quasis as AstNode[]).length === 1
        ) {
          const cooked = expr.quasis[0]?.value?.cooked
          if (typeof cooked === 'string') {
            parts.pushStatic(escapeRawText(cooked, rawTextTag))
            continue
          }
        }

        if (rawTextTag !== undefined) {
          parts.pushExpr(`${use('ssrRawText')}(${JSON.stringify(rawTextTag)}, ${compileSubExpression(expr)})`)
          continue
        }

        // Inline `.map((item, idx?) => <jsx>)` directly into a flat `for` loop on `bufVar`!
        if (
          expr.type === 'CallExpression'
          && expr.callee?.type === 'MemberExpression'
          && !expr.callee.computed
          && expr.callee.property?.name === 'map'
          && expr.arguments?.length === 1
        ) {
          const cb = expr.arguments[0] as AstNode
          if ((cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') && !cb.async && cb.body !== null) {
            const body = (cb.body.type === 'ParenthesizedExpression' ? cb.body.expression : cb.body) as AstNode
            if (body.type === 'JSXElement' || body.type === 'JSXFragment') {
              const target = compileSubExpression(expr.callee.object)
              const params = cb.params as AstNode[]
              const itemParam = params[0]?.type === 'Identifier' ? params[0].name as string : undefined
              const idxParam = params[1]?.type === 'Identifier' ? params[1].name as string : undefined

              // Only `(item)` and `(item, index)` inline; any other shape goes through ssrLoop with its params as written.
              if (itemParam !== undefined && params.length <= 2 && (params.length < 2 || idxParam !== undefined)) {
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
                emitIntoBuffer(body, bufVar, innerParts, flushInner, s => innerStmts.push(s))
                flushInner()

                pushStmt(
                  `const ${arrVar} = ${target}; if (${arrVar}) for (let ${idxVar} = 0; ${idxVar} < ${arrVar}.length; ${idxVar}++) { const ${itemParam} = ${arrVar}[${idxVar}]; ${innerStmts.join(' ')} }`,
                )
                if (emitMarkers && !isLast)
                  parts.pushStatic('<!---->')
                continue
              }
            }
          }
        }

        parts.pushExpr(compileExpressionAsString(expr, hasSiblings, isLast))
      }
    }
  }

  function compileExpressionAsString(expr: AstNode, hasSiblings: boolean, isLast = true): string {
    if (expr.type === 'JSXElement' || expr.type === 'JSXFragment')
      return compileJsxToStringExpr(expr)

    if (
      expr.type === 'CallExpression'
      && expr.callee?.type === 'MemberExpression'
      && !expr.callee.computed
      && expr.callee.property?.name === 'map'
      && expr.arguments?.length === 1
    ) {
      const cb = expr.arguments[0] as AstNode
      if ((cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') && !cb.async && cb.body !== null) {
        const body = (cb.body.type === 'ParenthesizedExpression' ? cb.body.expression : cb.body) as AstNode
        if (body.type === 'JSXElement' || body.type === 'JSXFragment') {
          const target = compileSubExpression(expr.callee.object)
          const params = (cb.params as AstNode[]).map(p => code.slice(p.start, p.end)).join(', ')
          const rendered = `${use('ssrLoop')}(${target}, (${params}) => ${compileJsxToStringExpr(body)})`
          return emitMarkers && !isLast ? `(${rendered}) + "<!---->"` : rendered
        }
        if (body.type === 'BlockStatement') {
          let blockHasJsx = false
          walk(body, (c) => {
            if (c.type === 'JSXElement' || c.type === 'JSXFragment') {
              blockHasJsx = true
              return false
            }
            return undefined
          })
          if (blockHasJsx) {
            const rendered = `${use('esc')}(${compileSubExpression(expr)})`
            return emitMarkers && !isLast ? `(${rendered}) + "<!---->"` : rendered
          }
        }
      }
    }

    if (expr.type === 'LogicalExpression' && expr.operator === '&&') {
      const right = unwrapParens(expr.right)
      if (right.type === 'JSXElement' || right.type === 'JSXFragment') {
        const left = compileSubExpression(expr.left)
        const emptyVal = emitMarkers && !isLast ? '"<!---->"' : '""'
        return `((${left}) ? (${compileJsxToStringExpr(right)}) : ${emptyVal})`
      }
    }

    if (expr.type === 'ConditionalExpression') {
      const consNode = unwrapParens(expr.consequent)
      const altNode = unwrapParens(expr.alternate)
      if (consNode.type === 'JSXElement' || consNode.type === 'JSXFragment' || altNode.type === 'JSXElement' || altNode.type === 'JSXFragment') {
        const test = compileSubExpression(expr.test)
        const cons = compileExpressionAsString(consNode, false, true)
        const alt = compileExpressionAsString(altNode, false, true)
        const base = `((${test}) ? (${cons}) : (${alt}))`
        return emitMarkers && !isLast ? `(${base} || "<!---->")` : base
      }
    }

    const exprCode = compileSubExpression(expr)
    const rendered = `${use('esc')}(${exprCode})`
    if (emitMarkers && hasSiblings)
      return isLast ? `"<!---->" + ${rendered}` : `"<!---->" + ${rendered} + "<!---->"`
    return rendered
  }

  function emitComponent(node: AstNode, tag: string, parts: StringParts): void {
    const attrs = node.openingElement.attributes as AstNode[]
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
        else if (attr.value?.type === 'JSXExpressionContainer') {
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
      else if (attr.value.type === 'JSXExpressionContainer') {
        const expr = attr.value.expression as AstNode
        const lit = isSimpleLiteral(expr)
        if (lit.ok)
          staticPropsObj[name] = lit.value
        else
          allStaticProps = false
        propEntries.push(`${propKey}: ${compileSubExpression(expr)}`)
      }
    }

    const childNodes = node.children as AstNode[]
    const meaningfulChildren = childNodes.filter(c =>
      !(c.type === 'JSXText' && cleanJsxText(c.value as string) === '')
      && !(c.type === 'JSXExpressionContainer' && c.expression.type === 'JSXEmptyExpression'),
    )
    const hasChildren = meaningfulChildren.length > 0

    // Special case: <Suspense fallback={...}><AsyncComp /></Suspense> passes the raw component call/Promise!
    if (tag === 'Suspense') {
      if (meaningfulChildren.length === 1) {
        const only = meaningfulChildren[0]!
        if (only.type === 'JSXElement' && isComponentTag(jsxTagName(only.openingElement.name))) {
          const innerTag = jsxTagName(only.openingElement.name)
          const innerProps: string[] = []
          for (const attr of only.openingElement.attributes as AstNode[]) {
            if (attr.type === 'JSXAttribute') {
              const n = jsxTagName(attr.name)
              const k = /^[A-Za-z_$][\w$]*$/.test(n) ? n : JSON.stringify(n)
              if (attr.value === null)
                innerProps.push(`${k}: true`)
              else if (attr.value.type === 'Literal')
                innerProps.push(`${k}: ${JSON.stringify(attr.value.value)}`)
              else if (attr.value.type === 'JSXExpressionContainer')
                innerProps.push(`${k}: ${compileSubExpression(attr.value.expression)}`)
            }
          }
          propEntries.push(`children: ${innerTag}({ ${innerProps.join(', ')} })`)
        }
        else if (only.type === 'JSXExpressionContainer') {
          propEntries.push(`children: ${compileSubExpression(only.expression)}`)
        }
        else {
          propEntries.push(`children: ${use('raw')}(${compileJsxToStringExpr(only)})`)
        }
      }
      const propsObj = propEntries.length > 0 ? `{ ${propEntries.join(', ')} }` : '{}'
      parts.pushExpr(`${use('ssrChild')}(${tag}(${propsObj}))`)
      return
    }

    const childExpr = hasChildren ? compileJsxToStringExpr({ type: 'JSXFragment', children: childNodes }) : '""'

    const islandInfo = islands?.get(tag)
    if (islandInfo !== undefined) {
      const propsCode = `{ ${propEntries.join(', ')} }`
      const callPropsCode = hasChildren
        ? `{ ${[...propEntries, `children: ${use('raw')}("<kay-slot>" + (${childExpr}) + "</kay-slot>")`].join(', ')} }`
        : propsCode
      const resolvedHydrate = staticHydrate ?? (hydrateExpr === undefined ? islandInfo.defaultHydrate : undefined)

      // Compile-time static island props fast path (only when not inside an island-reachable component):
      // 0 JSON.stringify / Object.keys / escAttr at runtime, while still incrementing island depth!
      if (!emitMarkers && allStaticProps && (hydrateExpr === undefined || staticHydrate !== undefined)) {
        const pAttr = Object.keys(staticPropsObj).length > 0
          ? ` p="${escapeStaticAttr(JSON.stringify(staticPropsObj))}"`
          : ''
        const hAttr = resolvedHydrate !== undefined && resolvedHydrate !== 'load'
          ? ` h="${escapeStaticAttr(resolvedHydrate)}"`
          : ''
        const openTag = `<kay-island c="${escapeStaticAttr(islandInfo.chunk)}"${pAttr}${hAttr}>`
        parts.pushStatic(openTag)
        if (resolvedHydrate !== 'client')
          parts.pushExpr(`${use('ssrInIsland')}(() => ${use('ssrChild')}(${tag}(${callPropsCode})))`)
        parts.pushStatic('</kay-island>')
        return
      }

      const hydrateArg = hydrateExpr ?? (islandInfo.defaultHydrate !== undefined ? JSON.stringify(islandInfo.defaultHydrate) : 'undefined')
      if (allStaticProps && (hydrateExpr === undefined || staticHydrate !== undefined)) {
        parts.pushExpr(
          `${use('ssrIsland')}(${JSON.stringify(islandInfo.id)}, ${JSON.stringify(islandInfo.chunk)}, () => ${use('ssrChild')}(${tag}(${callPropsCode})), ${propsCode}, ${hydrateArg})`,
        )
        return
      }

      // Hoist dynamic island props into a single binding so expressions (side effects & await) evaluate once!
      const pVar = `_p${loopCounter++}`
      const argNames = [pVar]
      const argExprs = [propsCode]
      let callArg = pVar
      if (hasChildren) {
        let childSlotVal = childExpr
        if (containsDirectAwait({ type: 'JSXFragment', children: childNodes })) {
          const cVar = `_c${loopCounter++}`
          argNames.push(cVar)
          argExprs.push(childExpr)
          childSlotVal = cVar
        }
        callArg = `{ ...${pVar}, children: ${use('raw')}("<kay-slot>" + (${childSlotVal}) + "</kay-slot>") }`
      }
      let hArg = hydrateArg
      if (hydrateExpr !== undefined && staticHydrate === undefined) {
        const hVar = `_h${loopCounter++}`
        argNames.push(hVar)
        argExprs.push(hydrateExpr)
        hArg = hVar
      }
      parts.pushExpr(
        `((${argNames.join(', ')}) => ${use('ssrIsland')}(${JSON.stringify(islandInfo.id)}, ${JSON.stringify(islandInfo.chunk)}, () => ${use('ssrChild')}(${tag}(${callArg})), ${pVar}, ${hArg}))(${argExprs.join(', ')})`,
      )
      return
    }

    if (hasChildren)
      propEntries.push(`children: ${use('raw')}(${childExpr})`)

    const propsObj = propEntries.length > 0 ? `{ ${propEntries.join(', ')} }` : '{}'
    parts.pushExpr(`${use('ssrChild')}(${tag}(${propsObj}))`)
  }

  function compileJsxToStringExpr(node: AstNode): string {
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

  function compileRootJsx(node: AstNode): string {
    return `${use('raw')}(${compileJsxToStringExpr(node)})`
  }

  walk(program, (node) => {
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
      editor.replace(node.start, node.end, compileRootJsx(node))
      return false
    }
    return undefined
  })

  if (used.size > 0) {
    const specifiers = [...used].sort().map(name => `${name} as __${name}`).join(', ')
    editor.prepend(`import { ${specifiers} } from 'kay/ssr';\n`)
  }

  return { code: editor.toString(), analysis }
}

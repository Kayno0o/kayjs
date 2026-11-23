// Kay v2 SSR compiler: compiles TSX directly to flat string concatenation, inline for-loops,
// static attribute literal folding, and compile-time static island props.

import type { AstNode, ModuleAnalysis } from './analyze'
import { analyzeModule, parseTsx, walk } from './analyze'
import { SourceEditor } from './patch'

export function escapeStaticText(str: string): string {
  return str.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const EVENT_ATTR = /^on[A-Z]/

export interface IslandBinding {
  id: string
  chunk: string
  defaultHydrate?: string | undefined
}

export interface CompileSsrOptions {
  islands?: ReadonlyMap<string, IslandBinding> | undefined
  isIsland?: boolean | undefined
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
    || (node.type === 'Literal' && (node.value === null || node.value === false))
}

function formatStaticAttrBranch(attrName: string, node: AstNode): string | undefined {
  if (isStaticNullish(node))
    return '""'
  if (node.type === 'Literal') {
    if (node.value === true)
      return JSON.stringify(` ${attrName}`)
    if (typeof node.value === 'string' || typeof node.value === 'number')
      return JSON.stringify(` ${attrName}="${escapeStaticAttr(String(node.value))}"`)
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
  const isIsland = options.isIsland ?? analysis.isInteractive

  function compileSubExpression(node: AstNode): string {
    let hasNestedJsx = false
    walk(node, (child) => {
      if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
        hasNestedJsx = true
        return false
      }
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
          innerHtmlExpr = `${use('ssrChild')}(${compileSubExpression(attr.value.expression)})`
        continue
      }

      const name = rawName === 'className' ? 'class' : rawName === 'htmlFor' ? 'for' : rawName
      if (attr.value === null) {
        parts.pushStatic(` ${name}`)
      }
      else if (attr.value.type === 'Literal') {
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
      emitChildrenIntoBuffer(node.children as AstNode[], bufVar, parts, flushParts, pushStmt)
    parts.pushStatic(`</${tag}>`)
  }

  function emitChildrenIntoBuffer(
    children: AstNode[],
    bufVar: string,
    parts: StringParts,
    flushParts: () => void,
    pushStmt: (stmt: string) => void,
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
        parts.pushStatic(cleanJsxText(child.value as string))
      }
      else if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
        emitIntoBuffer(child, bufVar, parts, flushParts, pushStmt)
      }
      else if (child.type === 'JSXExpressionContainer') {
        const expr = child.expression as AstNode

        // Fold static string literal expressions like `{' '}` directly into static text
        if (expr.type === 'Literal' && typeof expr.value === 'string') {
          parts.pushStatic(escapeStaticText(expr.value))
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
          if ((cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') && cb.body !== null) {
            const body = (cb.body.type === 'ParenthesizedExpression' ? cb.body.expression : cb.body) as AstNode
            if (body.type === 'JSXElement' || body.type === 'JSXFragment') {
              const target = compileSubExpression(expr.callee.object)
              const params = cb.params as AstNode[]
              const itemParam = params[0]?.type === 'Identifier' ? params[0].name as string : undefined
              const idxParam = params[1]?.type === 'Identifier' ? params[1].name as string : undefined

              if (itemParam !== undefined) {
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
                if (isIsland && !isLast)
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
      if ((cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') && cb.body !== null) {
        const body = (cb.body.type === 'ParenthesizedExpression' ? cb.body.expression : cb.body) as AstNode
        if (body.type === 'JSXElement' || body.type === 'JSXFragment') {
          const target = compileSubExpression(expr.callee.object)
          const params = (cb.params as AstNode[]).map(p => code.slice(p.start, p.end)).join(', ')
          return `${use('ssrLoop')}(${target}, (${params}) => ${compileJsxToStringExpr(body)})`
        }
      }
    }

    if (expr.type === 'LogicalExpression' && expr.operator === '&&') {
      const right = unwrapParens(expr.right)
      if (right.type === 'JSXElement' || right.type === 'JSXFragment') {
        const left = compileSubExpression(expr.left)
        const emptyVal = isIsland && !isLast ? '"<!---->"' : '""'
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
        return isIsland && !isLast ? `(${base} || "<!---->")` : base
      }
    }

    const exprCode = compileSubExpression(expr)
    const rendered = `${use('esc')}(${exprCode})`
    if (isIsland && hasSiblings)
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

    const islandInfo = !isIsland ? islands?.get(tag) : undefined
    if (islandInfo !== undefined) {
      const propsCode = `{ ${propEntries.join(', ')} }`
      const callPropsCode = hasChildren
        ? `{ ${[...propEntries, `children: ${use('raw')}("<kay-slot>" + (${childExpr}) + "</kay-slot>")`].join(', ')} }`
        : propsCode
      const resolvedHydrate = staticHydrate ?? (hydrateExpr === undefined ? islandInfo.defaultHydrate : undefined)

      // Compile-time static island props fast path: 0 JSON.stringify / Object.keys / escAttr at runtime!
      if (allStaticProps && (hydrateExpr === undefined || staticHydrate !== undefined)) {
        const pAttr = Object.keys(staticPropsObj).length > 0
          ? ` p="${escapeStaticAttr(JSON.stringify(staticPropsObj))}"`
          : ''
        const hAttr = resolvedHydrate !== undefined && resolvedHydrate !== 'load'
          ? ` h="${escapeStaticAttr(resolvedHydrate)}"`
          : ''
        const openTag = `<kay-island c="${escapeStaticAttr(islandInfo.chunk)}"${pAttr}${hAttr}>`
        parts.pushStatic(openTag)
        if (resolvedHydrate !== 'client')
          parts.pushExpr(`${use('ssrChild')}(${tag}(${callPropsCode}))`)
        parts.pushStatic('</kay-island>')
        return
      }

      const hydrateArg = hydrateExpr ?? (islandInfo.defaultHydrate !== undefined ? JSON.stringify(islandInfo.defaultHydrate) : 'undefined')
      parts.pushExpr(
        `${use('ssrIsland')}(${JSON.stringify(islandInfo.id)}, ${JSON.stringify(islandInfo.chunk)}, () => ${use('ssrChild')}(${tag}(${callPropsCode})), ${propsCode}, ${hydrateArg})`,
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
  })

  if (used.size > 0) {
    const specifiers = [...used].sort().map(name => `${name} as __${name}`).join(', ')
    editor.prepend(`import { ${specifiers} } from 'kay/ssr';\n`)
  }

  return { code: editor.toString(), analysis }
}

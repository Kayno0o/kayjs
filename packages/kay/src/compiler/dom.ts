// Kay v2 Client DOM compiler: compiles TSX to hoisted template() clones, child-path walks,
// delegated events, compiler-safe destructured props, and fine-grained keyed .map() loops.

import type { AstNode, ModuleAnalysis } from './analyze'
import { analyzeModule, parseTsx, walk } from './analyze'
import { SourceEditor } from './patch'
import { cleanJsxText } from './ssr'

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const SVG_CHILD_TAGS = new Set([
  'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse',
  'g', 'defs', 'use', 'text', 'tspan', 'clipPath', 'mask',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'symbol',
  'marker', 'filter', 'feGaussianBlur', 'foreignObject', 'animate',
])

const DELEGATED_EVENTS = new Set([
  'beforeinput', 'click', 'dblclick', 'focusin', 'focusout',
  'input', 'keydown', 'keyup', 'mousedown', 'mouseup',
  'pointerdown', 'pointerup', 'touchstart', 'touchend',
])

const DOM_PROPS = new Set(['value', 'checked', 'selected', 'muted', 'indeterminate'])
const EVENT_ATTR = /^on([A-Z]\w*)$/

export interface CompileDomOptions {
  analysis?: ModuleAnalysis | undefined
}

export interface CompileDomResult {
  code: string
  analysis: ModuleAnalysis
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

function escapeStaticAttr(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function collectPatternNames(pattern: AstNode, out: Set<string>): void {
  if (!pattern)
    return
  if (pattern.type === 'Identifier') {
    out.add(pattern.name as string)
  }
  else if (pattern.type === 'AssignmentPattern') {
    collectPatternNames(pattern.left, out)
  }
  else if (pattern.type === 'RestElement') {
    collectPatternNames(pattern.argument, out)
  }
  else if (pattern.type === 'ArrayPattern') {
    for (const el of pattern.elements as (AstNode | null)[]) {
      if (el !== null)
        collectPatternNames(el, out)
    }
  }
  else if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties as AstNode[]) {
      if (prop.type === 'RestElement')
        collectPatternNames(prop.argument, out)
      else
        collectPatternNames(prop.value, out)
    }
  }
}

/** Rewrites free identifier reads inside an AST node while respecting shadowing and property keys. */
function rewriteFreeIdentifiers(
  source: string,
  rootNode: AstNode,
  replacements: ReadonlyMap<string, string>,
): string {
  if (replacements.size === 0)
    return source.slice(rootNode.start, rootNode.end)

  const offset = rootNode.start as number
  const editor = new SourceEditor(source.slice(rootNode.start, rootNode.end))

  function visit(node: AstNode | null | undefined, shadowed: Set<string>): void {
    if (!node || typeof node !== 'object')
      return

    switch (node.type) {
      case 'Identifier': {
        const name = node.name as string
        if (!shadowed.has(name)) {
          const rep = replacements.get(name)
          if (rep !== undefined)
            editor.replace(node.start - offset, node.end - offset, rep)
        }
        return
      }
      case 'MemberExpression': {
        visit(node.object, shadowed)
        if (node.computed)
          visit(node.property, shadowed)
        return
      }
      case 'Property': {
        if (node.computed)
          visit(node.key, shadowed)
        if (node.shorthand && node.value?.type === 'Identifier') {
          const name = node.value.name as string
          if (!shadowed.has(name) && replacements.has(name)) {
            editor.replace(node.start - offset, node.end - offset, `${name}: ${replacements.get(name)}`)
            return
          }
        }
        visit(node.value, shadowed)
        return
      }
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
      case 'FunctionDeclaration': {
        const nextShadow = new Set(shadowed)
        if (node.id?.name)
          nextShadow.add(node.id.name as string)
        for (const p of node.params as AstNode[])
          collectPatternNames(p, nextShadow)
        visit(node.body, nextShadow)
        return
      }
      case 'BlockStatement': {
        const nextShadow = new Set(shadowed)
        for (const stmt of node.body as AstNode[]) {
          if (stmt.type === 'VariableDeclaration') {
            for (const d of stmt.declarations as AstNode[]) {
              visit(d.init, nextShadow)
              collectPatternNames(d.id, nextShadow)
            }
          }
          else if (stmt.type === 'FunctionDeclaration') {
            if (stmt.id?.name)
              nextShadow.add(stmt.id.name as string)
            visit(stmt, nextShadow)
          }
          else {
            visit(stmt, nextShadow)
          }
        }
        return
      }
      case 'VariableDeclarator': {
        visit(node.init, shadowed)
        return
      }
      case 'JSXAttribute': {
        visit(node.value, shadowed)
        return
      }
      case 'JSXOpeningElement': {
        for (const attr of node.attributes as AstNode[])
          visit(attr, shadowed)
        return
      }
      default: {
        // Skip TypeScript type nodes
        if (typeof node.type === 'string' && node.type.startsWith('TS'))
          return
        for (const key of Object.keys(node)) {
          if (key === 'start' || key === 'end' || key === 'type')
            continue
          const val = node[key]
          if (Array.isArray(val)) {
            for (let i = 0; i < val.length; i++)
              visit(val[i] as AstNode, shadowed)
          }
          else if (val !== null && typeof val === 'object') {
            visit(val as AstNode, shadowed)
          }
        }
      }
    }
  }

  visit(rootNode, new Set())
  return editor.toString()
}

export function compileDom(filename: string, code: string, options: CompileDomOptions = {}): CompileDomResult {
  const program = options.analysis?.program ?? parseTsx(filename, code)
  const analysis = options.analysis ?? analyzeModule(filename, code, program)

  if (!analysis.hasJsx && !analysis.hasLoadExport)
    return { code, analysis }

  const editor = new SourceEditor(code)
  const used = new Set<string>()
  const templates: { name: string, html: string, isSvg?: boolean }[] = []
  const delegatedEvents = new Set<string>()
  let varCounter = 0

  const use = (name: string): string => {
    used.add(name)
    return `__${name}`
  }
  const freshVar = (prefix = '_e'): string => `${prefix}${varCounter++}`

  // Strip `export async function load(...)` in client builds
  for (const stmt of program.body as AstNode[]) {
    if (stmt.type === 'ExportNamedDeclaration') {
      const decl = stmt.declaration as AstNode | null
      if (decl?.type === 'FunctionDeclaration' && decl.id?.name === 'load')
        editor.remove(stmt.start, stmt.end)
    }
  }

  function compileExpression(node: AstNode, scopeRewrites: ReadonlyMap<string, string>): string {
    let hasNestedJsx = false
    walk(node, (child) => {
      if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
        hasNestedJsx = true
        return false
      }
    })
    if (!hasNestedJsx)
      return rewriteFreeIdentifiers(code, node, scopeRewrites)

    // Replace nested JSX roots inside this expression
    const subCode = code.slice(node.start, node.end)
    const offset = node.start as number
    const sub = new SourceEditor(subCode)

    walk(node, (child) => {
      if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
        sub.replace(child.start - offset, child.end - offset, compileRootJsx(child, scopeRewrites))
        return false
      }
    })

    // Also rewrite non-JSX free identifiers by applying identifier rewrites on non-JSX spans
    if (scopeRewrites.size === 0)
      return sub.toString()

    // Re-parse isn't needed: rewrite free identifiers cleanly on leaf expressions inside compileRootJsx,
    // and for outer expressions around JSX (e.g. `cond ? <A/> : <B/>`), compile directly:
    if (node.type === 'ConditionalExpression') {
      const test = compileExpression(node.test, scopeRewrites)
      const cons = compileExpression(node.consequent, scopeRewrites)
      const alt = compileExpression(node.alternate, scopeRewrites)
      return `(${test} ? ${cons} : ${alt})`
    }
    if (node.type === 'LogicalExpression') {
      const left = compileExpression(node.left, scopeRewrites)
      const right = compileExpression(node.right, scopeRewrites)
      return `(${left} ${node.operator} ${right})`
    }
    return sub.toString()
  }

  function compileComponentCall(node: AstNode, scopeRewrites: ReadonlyMap<string, string>): string {
    const tag = jsxTagName(node.openingElement.name)
    const propEntries: string[] = []

    for (const attr of node.openingElement.attributes as AstNode[]) {
      if (attr.type === 'JSXSpreadAttribute') {
        propEntries.push(`...(${compileExpression(attr.argument, scopeRewrites)})`)
        continue
      }
      const name = jsxTagName(attr.name)
      if (name === 'key' || name === '$hydrate')
        continue

      const propKey = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
      if (attr.value === null) {
        propEntries.push(`${propKey}: true`)
      }
      else if (attr.value.type === 'Literal') {
        propEntries.push(`${propKey}: ${JSON.stringify(attr.value.value)}`)
      }
      else if (attr.value.type === 'JSXExpressionContainer') {
        const expr = attr.value.expression as AstNode
        const exprCode = compileExpression(expr, scopeRewrites)
        // Reactive getter for dynamic expressions; plain property for literals, functions, and bare identifiers (signals)
        const isStatic = expr.type === 'Literal'
          || expr.type === 'ArrowFunctionExpression'
          || expr.type === 'FunctionExpression'
        if (isStatic)
          propEntries.push(`${propKey}: ${exprCode}`)
        else
          propEntries.push(`get ${propKey}() { return ${exprCode} }`)
      }
    }

    const meaningful = filterChildren(node.children as AstNode[])
    if (meaningful.length === 1) {
      const child = meaningful[0]!
      if (child.type === 'JSXText')
        propEntries.push(`children: ${JSON.stringify(cleanJsxText(child.value as string))}`)
      else if (child.type === 'JSXElement' || child.type === 'JSXFragment')
        propEntries.push(`get children() { return ${compileRootJsx(child, scopeRewrites)} }`)
      else if (child.type === 'JSXExpressionContainer')
        propEntries.push(`get children() { return ${compileExpression(child.expression, scopeRewrites)} }`)
    }
    else if (meaningful.length > 1) {
      const items = meaningful.map((c) => {
        if (c.type === 'JSXText')
          return JSON.stringify(cleanJsxText(c.value as string))
        if (c.type === 'JSXElement' || c.type === 'JSXFragment')
          return compileRootJsx(c, scopeRewrites)
        return compileExpression(c.expression, scopeRewrites)
      })
      propEntries.push(`get children() { return [${items.join(', ')}] }`)
    }

    const propsObj = propEntries.length > 0 ? `{ ${propEntries.join(', ')} }` : '{}'
    return `${tag}(${propsObj})`
  }

  function filterChildren(children: AstNode[]): AstNode[] {
    return children.filter((c) => {
      if (c.type === 'JSXText')
        return cleanJsxText(c.value as string) !== ''
      if (c.type === 'JSXExpressionContainer' && c.expression.type === 'JSXEmptyExpression')
        return false
      return true
    })
  }

  function extractKeyExpr(jsxEl: AstNode): AstNode | undefined {
    if (jsxEl.type !== 'JSXElement')
      return undefined
    for (const attr of jsxEl.openingElement.attributes as AstNode[]) {
      if (attr.type === 'JSXAttribute' && attr.name?.name === 'key') {
        if (attr.value?.type === 'JSXExpressionContainer')
          return attr.value.expression as AstNode
        if (attr.value?.type === 'Literal')
          return attr.value as AstNode
      }
    }
    return undefined
  }

  function compileElementTree(rootEl: AstNode, scopeRewrites: ReadonlyMap<string, string>): string {
    interface NodeRef {
      varName: string
      parentVar: string
      childIndex: number
    }

    const ops: string[] = []
    const rootVar = freshVar('_e')
    const childRefs = new Map<string, string>() // "parentVar:index" -> varName
    const childMaxIdx = new Map<string, number>()

    function ensureNode(parentVar: string, index: number): string {
      const key = `${parentVar}:${index}`
      const existing = childRefs.get(key)
      if (existing !== undefined)
        return existing
      const v = freshVar('_e')
      childRefs.set(key, v)
      const prevMax = childMaxIdx.get(parentVar) ?? -1
      if (index > prevMax)
        childMaxIdx.set(parentVar, index)
      return v
    }

    const walkPlan: { parentVar: string, index: number, varName: string }[] = []

    function requestChild(parentVar: string, index: number): string {
      const key = `${parentVar}:${index}`
      const existing = childRefs.get(key)
      if (existing !== undefined)
        return existing
      const v = ensureNode(parentVar, index)
      walkPlan.push({ parentVar, index, varName: v })
      return v
    }

    function buildHtml(el: AstNode, elVar: string): string {
      const tag = jsxTagName(el.openingElement.name)
      let html = `<${tag}`

      for (const attr of el.openingElement.attributes as AstNode[]) {
        if (attr.type === 'JSXSpreadAttribute') {
          ops.push(`${use('spread')}(${elVar}, () => (${compileExpression(attr.argument, scopeRewrites)}));`)
          continue
        }
        const rawName = jsxTagName(attr.name)
        if (rawName === 'key' || rawName === '$hydrate')
          continue

        if (rawName === 'ref' && attr.value?.type === 'JSXExpressionContainer') {
          const refCode = compileExpression(attr.value.expression, scopeRewrites)
          ops.push(`(${refCode})(${elVar});`)
          continue
        }

        if (rawName === 'innerHTML') {
          if (attr.value?.type === 'Literal')
            ops.push(`${use('setInnerHtml')}(${elVar}, ${JSON.stringify(String(attr.value.value))});`)
          else if (attr.value?.type === 'JSXExpressionContainer')
            ops.push(`${use('effect')}(() => ${use('setInnerHtml')}(${elVar}, ${compileExpression(attr.value.expression, scopeRewrites)}));`)
          continue
        }

        const eventMatch = EVENT_ATTR.exec(rawName)
        if (eventMatch !== null && attr.value?.type === 'JSXExpressionContainer') {
          const eventName = eventMatch[1]!.toLowerCase()
          const handlerCode = compileExpression(attr.value.expression, scopeRewrites)
          if (DELEGATED_EVENTS.has(eventName)) {
            delegatedEvents.add(eventName)
            ops.push(`${elVar}.$$${eventName} = ${handlerCode};`)
          }
          else {
            ops.push(`${use('on')}(${elVar}, ${JSON.stringify(eventName)}, ${handlerCode});`)
          }
          continue
        }

        const name = rawName === 'className' ? 'class' : rawName === 'htmlFor' ? 'for' : rawName
        if (attr.value === null) {
          html += ` ${name}`
        }
        else if (attr.value.type === 'Literal') {
          html += ` ${name}="${escapeStaticAttr(String(attr.value.value))}"`
        }
        else if (attr.value.type === 'JSXExpressionContainer') {
          const exprCode = compileExpression(attr.value.expression, scopeRewrites)
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

      const meaningful = filterChildren(el.children as AstNode[])
      let domIndex = 0

      for (let i = 0; i < meaningful.length; i++) {
        const child = meaningful[i]!
        const isLast = i === meaningful.length - 1

        if (child.type === 'JSXText') {
          html += cleanJsxText(child.value as string)
          domIndex++
          continue
        }

        if (child.type === 'JSXElement') {
          const childTag = jsxTagName(child.openingElement.name)
          if (isComponentTag(childTag)) {
            const anchorVar = isLast ? 'null' : requestChild(elVar, domIndex)
            if (!isLast) {
              html += '<!---->'
              domIndex++
            }
            const callCode = compileComponentCall(child, scopeRewrites)
            ops.push(`${use('insert')}(${elVar}, () => ${callCode}, ${anchorVar});`)
          }
          else {
            // Check if child element (or any descendant) needs bindings before allocating a var
            const subOpsBefore = ops.length
            const subWalkBefore = walkPlan.length
            const placeholderVar = `__SUB_${varCounter++}`
            const subHtml = buildHtml(child, placeholderVar)
            const needed = ops.length > subOpsBefore || walkPlan.length > subWalkBefore
            if (needed) {
              const realVar = requestChild(elVar, domIndex)
              for (let k = subOpsBefore; k < ops.length; k++)
                ops[k] = ops[k]!.replaceAll(placeholderVar, realVar)
              for (let k = subWalkBefore; k < walkPlan.length; k++) {
                if (walkPlan[k]!.parentVar === placeholderVar)
                  walkPlan[k]!.parentVar = realVar
              }
            }
            html += subHtml
            domIndex++
          }
          continue
        }

        if (child.type === 'JSXFragment') {
          const anchorVar = isLast ? 'null' : requestChild(elVar, domIndex)
          if (!isLast) {
            html += '<!---->'
            domIndex++
          }
          const fragCode = compileRootJsx(child, scopeRewrites)
          ops.push(`${use('insert')}(${elVar}, () => ${fragCode}, ${anchorVar});`)
          continue
        }

        if (child.type === 'JSXExpressionContainer') {
          const expr = child.expression as AstNode

          // Case 1: Keyed `.map((item, idx?) => <jsx>)` → `__loop(...)`
          if (
            expr.type === 'CallExpression'
            && expr.callee?.type === 'MemberExpression'
            && !expr.callee.computed
            && expr.callee.property?.name === 'map'
            && expr.arguments?.length === 1
          ) {
            const cb = expr.arguments[0] as AstNode
            const cbBody = cb.body?.type === 'ParenthesizedExpression' ? cb.body.expression : cb.body
            if (
              (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression')
              && (cbBody?.type === 'JSXElement' || cbBody?.type === 'JSXFragment')
            ) {
              const anchorVar = isLast ? 'null' : requestChild(elVar, domIndex)
              if (!isLast) {
                html += '<!---->'
                domIndex++
              }

              const eachCode = compileExpression(expr.callee.object, scopeRewrites)
              const params = cb.params as AstNode[]
              const firstParam = params[0]
              const idxParam = params[1]?.type === 'Identifier' ? params[1].name as string : undefined

              // Fast path: provably static constant array (e.g. `NAV.map(...)`) -> lightweight `eachStatic` (0 bytes of LIS reconciler!)
              const isStaticArr = expr.callee.object.type === 'Identifier' && !scopeRewrites.has(expr.callee.object.name as string)
              if (isStaticArr) {
                const rawParams = params.map(p => code.slice(p.start, p.end)).join(', ')
                const shadowed = new Map(scopeRewrites)
                for (const p of params) {
                  const names = new Set<string>()
                  collectPatternNames(p, names)
                  for (const n of names)
                    shadowed.delete(n)
                }
                const rowBody = compileRootJsx(cbBody, shadowed)
                ops.push(`${use('eachStatic')}(${elVar}, ${anchorVar}, ${eachCode}, (${rawParams}) => ${rowBody});`)
                continue
              }

              const keyAst = extractKeyExpr(cbBody)

              const rowSig = freshVar('_r')
              const idxSig = idxParam !== undefined ? freshVar('_i') : undefined
              const rowRewrites = new Map(scopeRewrites)
              let keyFn: string

              if (firstParam?.type === 'ObjectPattern') {
                const patCode = code.slice(firstParam.start, firstParam.end)
                keyFn = keyAst !== undefined
                  ? `(${patCode}${idxParam ? `, ${idxParam}` : ''}) => ${code.slice(keyAst.start, keyAst.end)}`
                  : `(_item) => _item`
                for (const prop of firstParam.properties as AstNode[]) {
                  if (prop.type === 'Property' && prop.key?.type === 'Identifier') {
                    const propKey = prop.key.name as string
                    if (prop.value.type === 'Identifier') {
                      rowRewrites.set(prop.value.name as string, `${rowSig}.value.${propKey}`)
                    }
                    else if (prop.value.type === 'AssignmentPattern' && prop.value.left?.type === 'Identifier') {
                      const defCode = code.slice(prop.value.right.start, prop.value.right.end)
                      rowRewrites.set(prop.value.left.name as string, `(${rowSig}.value.${propKey} === undefined ? ${defCode} : ${rowSig}.value.${propKey})`)
                    }
                  }
                }
              }
              else {
                const itemParam = firstParam?.type === 'Identifier' ? firstParam.name as string : '_item'
                keyFn = keyAst !== undefined
                  ? `(${itemParam}${idxParam ? `, ${idxParam}` : ''}) => ${code.slice(keyAst.start, keyAst.end)}`
                  : `(${itemParam}) => ${itemParam}`
                rowRewrites.set(itemParam, `${rowSig}.value`)
              }
              if (idxParam !== undefined && idxSig !== undefined)
                rowRewrites.set(idxParam, `${idxSig}.value`)

              const rowBody = compileRootJsx(cbBody, rowRewrites)
              const rowParams = idxSig !== undefined ? `${rowSig}, ${idxSig}` : rowSig
              ops.push(`${use('loop')}(${elVar}, ${anchorVar}, () => ${eachCode}, ${keyFn}, (${rowParams}) => ${rowBody});`)
              continue
            }
          }

          // Case 2: `cond && <jsx>` → `__show(...)`
          if (expr.type === 'LogicalExpression' && expr.operator === '&&') {
            const right = unwrapParens(expr.right)
            if (right.type === 'JSXElement' || right.type === 'JSXFragment') {
              const anchorVar = isLast ? 'null' : requestChild(elVar, domIndex)
              if (!isLast) {
                html += '<!---->'
                domIndex++
              }
              const whenCode = compileExpression(expr.left, scopeRewrites)
              const trueCode = compileRootJsx(right, scopeRewrites)
              ops.push(`${use('show')}(${elVar}, ${anchorVar}, () => ${whenCode}, () => ${trueCode});`)
              continue
            }
          }

          // Case 3: `cond ? <a/> : <b/>` → `__show(...)`
          if (expr.type === 'ConditionalExpression') {
            const consNode = unwrapParens(expr.consequent)
            const altNode = unwrapParens(expr.alternate)
            if (consNode.type === 'JSXElement' || consNode.type === 'JSXFragment' || altNode.type === 'JSXElement' || altNode.type === 'JSXFragment') {
              const anchorVar = isLast ? 'null' : requestChild(elVar, domIndex)
              if (!isLast) {
                html += '<!---->'
                domIndex++
              }
              const whenCode = compileExpression(expr.test, scopeRewrites)
              const trueCode = consNode.type === 'JSXElement' || consNode.type === 'JSXFragment'
                ? compileRootJsx(consNode, scopeRewrites)
                : compileExpression(consNode, scopeRewrites)
              const falseCode = altNode.type === 'JSXElement' || altNode.type === 'JSXFragment'
                ? compileRootJsx(altNode, scopeRewrites)
                : compileExpression(altNode, scopeRewrites)
              ops.push(`${use('show')}(${elVar}, ${anchorVar}, () => ${whenCode}, () => ${trueCode}, () => ${falseCode});`)
              continue
            }
          }

          // Case 4: Dynamic children slot / Node insertion (`{children}` / `{props.children}`)
          const isChildrenExpr = (expr.type === 'Identifier' && expr.name === 'children')
            || (expr.type === 'MemberExpression' && !expr.computed && expr.property?.name === 'children')
          const exprCode = compileExpression(expr, scopeRewrites)
          if (isChildrenExpr) {
            const anchorVar = isLast ? 'null' : requestChild(elVar, domIndex)
            if (!isLast) {
              html += '<!---->'
              domIndex++
            }
            ops.push(`${use('insert')}(${elVar}, () => ${exprCode}, ${anchorVar});`)
            continue
          }

          // Case 5: Dynamic text / expression binding
          if (meaningful.length === 1) {
            // Sole dynamic child: 0 comment markers!
            html += ' '
            domIndex++
            const txtVar = freshVar('_txt')
            ops.push(`const ${txtVar} = ${use('firstText')}(${elVar});`)
            ops.push(`${use('effect')}(() => ${use('setText')}(${txtVar}, ${exprCode}));`)
          }
          else {
            // Sibling dynamic child: comment marker + text node
            const markerVar = requestChild(elVar, domIndex)
            html += '<!----> '
            domIndex += 2
            const txtVar = freshVar('_txt')
            ops.push(`const ${txtVar} = ${use('textAfter')}(${markerVar});`)
            ops.push(`${use('effect')}(() => ${use('setText')}(${txtVar}, ${exprCode}));`)
          }
        }
      }

      html += `</${tag}>`
      return html
    }

    const html = buildHtml(rootEl, rootVar)
    const rootTag = jsxTagName(rootEl.openingElement.name)
    const tmplName = `_t${templates.length}`
    templates.push({ name: tmplName, html, isSvg: SVG_CHILD_TAGS.has(rootTag) })

    // Emit efficient parent->child sibling walks grouped by parentVar (breadth-first / parent-first order)
    const walkStmts: string[] = []
    const byParent = new Map<string, { index: number, varName: string }[]>()
    for (const item of walkPlan) {
      let arr = byParent.get(item.parentVar)
      if (arr === undefined) {
        arr = []
        byParent.set(item.parentVar, arr)
      }
      arr.push({ index: item.index, varName: item.varName })
    }

    // Emit walks in topological order (root first)
    const emittedParents = new Set<string>([rootVar])
    const queue = [rootVar]
    while (queue.length > 0) {
      const pVar = queue.shift()!
      const list = byParent.get(pVar)
      if (list === undefined)
        continue
      list.sort((a, b) => a.index - b.index)

      let prevVar: string | undefined
      let prevIdx = -1
      for (const { index, varName } of list) {
        let expr: string
        if (prevVar === undefined) {
          expr = `${pVar}.firstChild${'.nextSibling'.repeat(index)}`
        }
        else {
          expr = `${prevVar}${'.nextSibling'.repeat(index - prevIdx)}`
        }
        walkStmts.push(`const ${varName} = ${expr};`)
        prevVar = varName
        prevIdx = index
        if (!emittedParents.has(varName)) {
          emittedParents.add(varName)
          queue.push(varName)
        }
      }
    }

    if (walkStmts.length === 0 && ops.length === 0)
      return `${tmplName}()`

    return `(() => { const ${rootVar} = ${tmplName}(); ${walkStmts.join(' ')} ${ops.join(' ')} return ${rootVar}; })()`
  }

  function compileRootJsx(node: AstNode, scopeRewrites: ReadonlyMap<string, string>): string {
    if (node.type === 'JSXFragment') {
      const meaningful = filterChildren(node.children as AstNode[])
      if (meaningful.length === 0)
        return 'null'
      if (meaningful.length === 1 && meaningful[0]!.type === 'JSXElement')
        return compileRootJsx(meaningful[0]!, scopeRewrites)

      const items = meaningful.map((child) => {
        if (child.type === 'JSXElement' || child.type === 'JSXFragment')
          return compileRootJsx(child, scopeRewrites)
        if (child.type === 'JSXText')
          return `document.createTextNode(${JSON.stringify(cleanJsxText(child.value as string))})`
        return `document.createTextNode(String(${compileExpression(child.expression, scopeRewrites)} ?? ""))`
      })
      return `${use('frag')}(${items.join(', ')})`
    }

    const tag = jsxTagName(node.openingElement.name)
    if (isComponentTag(tag))
      return compileComponentCall(node, scopeRewrites)

    return compileElementTree(node, scopeRewrites)
  }

  // Handle component functions with destructured props + JSX compilation
  function processFunction(fn: AstNode): void {
    let fnHasJsx = false
    walk(fn.body, (child) => {
      if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
        fnHasJsx = true
        return false
      }
    })
    if (!fnHasJsx)
      return

    const propRewrites = new Map<string, string>()
    const firstParam = (fn.params as AstNode[])[0]
    if (firstParam !== undefined && firstParam.type === 'ObjectPattern') {
      const pVar = '__p'
      const typeAnn = firstParam.typeAnnotation ? code.slice(firstParam.typeAnnotation.start, firstParam.typeAnnotation.end) : ''
      editor.replace(firstParam.start, firstParam.end, `${pVar}${typeAnn}`)

      const extractedKeys: string[] = []
      let restName: string | undefined

      for (const prop of firstParam.properties as AstNode[]) {
        if (prop.type === 'Property' && prop.key?.type === 'Identifier') {
          const propKey = prop.key.name as string
          extractedKeys.push(propKey)
          if (prop.value.type === 'Identifier') {
            propRewrites.set(prop.value.name as string, `${pVar}.${propKey}`)
          }
          else if (prop.value.type === 'AssignmentPattern' && prop.value.left?.type === 'Identifier') {
            const defCode = code.slice(prop.value.right.start, prop.value.right.end)
            propRewrites.set(prop.value.left.name as string, `(${pVar}.${propKey} === undefined ? ${defCode} : ${pVar}.${propKey})`)
          }
        }
        else if (prop.type === 'RestElement' && prop.argument?.type === 'Identifier') {
          restName = prop.argument.name as string
        }
      }

      if (restName !== undefined)
        propRewrites.set(restName, `${use('omit')}(${pVar}, ${JSON.stringify(extractedKeys)})`)
    }

    // Rewrite prop reads in non-JSX statements of the function body, and compile JSX roots with propRewrites
    if (propRewrites.size > 0 && fn.body?.type === 'BlockStatement') {
      const shadowed = new Set<string>()
      for (const stmt of fn.body.body as AstNode[]) {
        let stmtHasJsx = false
        walk(stmt, (child) => {
          if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
            stmtHasJsx = true
            return false
          }
        })
        if (!stmtHasJsx) {
          const active = new Map<string, string>()
          for (const [k, v] of propRewrites) {
            if (!shadowed.has(k))
              active.set(k, v)
          }
          if (active.size > 0)
            editor.replace(stmt.start, stmt.end, rewriteFreeIdentifiers(code, stmt, active))
        }
        else {
          walk(stmt, (child) => {
            if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
              editor.replace(child.start, child.end, compileRootJsx(child, propRewrites))
              return false
            }
          })
        }
        if (stmt.type === 'VariableDeclaration') {
          for (const d of stmt.declarations as AstNode[])
            collectPatternNames(d.id, shadowed)
        }
      }
    }
    else {
      walk(fn.body, (child) => {
        if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
          editor.replace(child.start, child.end, compileRootJsx(child, propRewrites))
          return false
        }
      })
    }
  }

  walk(program, (node) => {
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      processFunction(node)
      return false
    }
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
      editor.replace(node.start, node.end, compileRootJsx(node, new Map()))
      return false
    }
  })

  // Emit imports, hoisted templates, and delegated events
  let header = ''
  if (templates.length > 0)
    use('template')
  if (delegatedEvents.size > 0)
    use('delegate')

  if (used.size > 0) {
    const hasLoop = used.delete('loop')
    const EXTRA_HELPERS = ['insert', 'omit', 'setInnerHtml', 'show', 'spread']
    const usedExtras: string[] = []
    for (const name of EXTRA_HELPERS) {
      if (used.delete(name))
        usedExtras.push(name)
    }
    if (used.size > 0) {
      const specifiers = [...used].sort().map(name => `${name} as __${name}`).join(', ')
      header += `import { ${specifiers} } from 'kay/dom';\n`
    }
    if (usedExtras.length > 0) {
      const specifiers = usedExtras.map(name => `${name} as __${name}`).join(', ')
      header += `import { ${specifiers} } from 'kay/dom-extras';\n`
    }
    if (hasLoop)
      header += `import { loop as __loop } from 'kay/dom-loop';\n`
  }
  for (const t of templates)
    header += `const ${t.name} = __template(${JSON.stringify(t.html)}${t.isSvg ? ', true' : ''});\n`
  if (delegatedEvents.size > 0)
    header += `__delegate(${JSON.stringify([...delegatedEvents].sort())});\n`

  if (header !== '')
    editor.prepend(header)

  return { code: editor.toString(), analysis }
}

// Kay v2 Client DOM compiler: compiles TSX to hoisted template() clones, child-path walks,
// delegated events, compiler-safe destructured props, and fine-grained keyed .map() loops.

import type { AstNode, ModuleAnalysis } from './analyze'
import { analyzeModule, loadDeclarations, parseTsx, walk } from './analyze'
import { SourceEditor } from './patch'
import { assertInnerHtmlNotReactObject, cleanJsxText, containsJsx, escapeStaticAttr, escapeStaticText, isComponentTag, isJsxNode, isStringBoolAttr, isUnsafeUrlAttr, jsxTagName, staticLiteral, unwrapParens, VOID_ELEMENTS } from './shared'

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
const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00A0',
  ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201C', rdquo: '\u201D', hellip: '\u2026', bull: '\u2022',
  middot: '\u00B7', laquo: '\u00AB', raquo: '\u00BB', lsaquo: '\u2039',
  rsaquo: '\u203A', shy: '\u00AD', ensp: '\u2002', emsp: '\u2003',
  thinsp: '\u2009', zwnj: '\u200C', zwj: '\u200D', lrm: '\u200E',
  rlm: '\u200F', prime: '\u2032', Prime: '\u2033', sect: '\u00A7',
  para: '\u00B6', dagger: '\u2020', Dagger: '\u2021', permil: '\u2030',
  copy: '\u00A9', reg: '\u00AE', trade: '\u2122', euro: '\u20AC',
  pound: '\u00A3', yen: '\u00A5', cent: '\u00A2', curren: '\u00A4',
  deg: '\u00B0', plusmn: '\u00B1', times: '\u00D7', divide: '\u00F7',
  frac12: '\u00BD', frac14: '\u00BC', frac34: '\u00BE', sup1: '\u00B9',
  sup2: '\u00B2', sup3: '\u00B3', micro: '\u00B5', minus: '\u2212',
  ne: '\u2260', le: '\u2264', ge: '\u2265', approx: '\u2248', infin: '\u221E',
  larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193',
  harr: '\u2194', crarr: '\u21B5', check: '\u2713', cross: '\u2717',
}

const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g

function decodeHtmlEntities(str: string): string {
  if (!str.includes('&'))
    return str
  return str.replace(ENTITY_RE, (match, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (dec !== undefined) {
      const cp = Number.parseInt(dec, 10)
      return cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) ? '\uFFFD' : String.fromCodePoint(cp)
    }
    if (hex !== undefined) {
      const cp = Number.parseInt(hex, 16)
      return cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) ? '\uFFFD' : String.fromCodePoint(cp)
    }
    if (named !== undefined && Object.prototype.hasOwnProperty.call(HTML_ENTITIES, named))
      return HTML_ENTITIES[named]!
    return match
  })
}

const PRIMITIVE_GLOBALS = new Set([
  'String', 'Number', 'Boolean', 'parseInt', 'parseFloat',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
])

const PRIMITIVE_METHODS = new Set([
  'toString', 'toFixed', 'toPrecision', 'toExponential', 'toLocaleString',
  'toLocaleDateString', 'toLocaleTimeString', 'toISOString', 'toUpperCase',
  'toLowerCase', 'toLocaleUpperCase', 'toLocaleLowerCase', 'trim', 'trimStart',
  'trimEnd', 'join', 'padStart', 'padEnd', 'repeat', 'replace', 'replaceAll',
  'substring', 'substr', 'charAt', 'charCodeAt', 'codePointAt', 'indexOf',
  'lastIndexOf', 'includes', 'startsWith', 'endsWith', 'getTime', 'getFullYear',
  'getMonth', 'getDate', 'getHours', 'getMinutes', 'getSeconds',
])

function isKnownPrimitiveCall(node: AstNode): boolean {
  const callee = node.callee as AstNode | undefined
  if (!callee)
    return false
  if (callee.type === 'Identifier' && PRIMITIVE_GLOBALS.has(callee.name as string))
    return true
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') {
    const prop = callee.property.name as string
    if (callee.object?.type === 'Identifier') {
      const obj = callee.object.name as string
      if (obj === 'Math' || (obj === 'JSON' && prop === 'stringify') || (obj === 'Date' && prop === 'now'))
        return true
    }
    if (PRIMITIVE_METHODS.has(prop))
      return true
  }
  return false
}

function mayReturnNode(node: AstNode): boolean {
  const cur = unwrapParens(node)
  if (cur.type === 'TSAsExpression' || cur.type === 'TSNonNullExpression' || cur.type === 'TSSatisfiesExpression' || cur.type === 'TSTypeAssertion')
    return mayReturnNode(cur.expression as AstNode)
  if (cur.type === 'CallExpression')
    return !isKnownPrimitiveCall(cur)
  if (cur.type === 'LogicalExpression')
    return mayReturnNode(cur.left as AstNode) || mayReturnNode(cur.right as AstNode)
  if (cur.type === 'ConditionalExpression')
    return mayReturnNode(cur.consequent as AstNode) || mayReturnNode(cur.alternate as AstNode)
  return false
}

export interface CompileDomOptions {
  analysis?: ModuleAnalysis | undefined
}

export interface CompileDomResult {
  code: string
  analysis: ModuleAnalysis
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

function withoutBindings(rewrites: ReadonlyMap<string, string>, patterns: AstNode[]): Map<string, string> {
  const names = new Set<string>()
  for (const pattern of patterns)
    collectPatternNames(pattern, names)
  const kept = new Map(rewrites)
  for (const name of names)
    kept.delete(name)
  return kept
}

// Names whose every binding in the file is a `const` holding an array literal: only those can be looped once without tracking, since a store, an import or a reassigned binding may change.
function literalArrayConsts(program: AstNode): Set<string> {
  const literal = new Set<string>()
  const other = new Set<string>()
  const bindOther = (pattern: AstNode | null | undefined): void => {
    if (pattern)
      collectPatternNames(pattern, other)
  }
  walk(program, (node) => {
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations as AstNode[]) {
        let init = decl.init as AstNode | null
        while (init && (init.type === 'TSAsExpression' || init.type === 'TSSatisfiesExpression' || init.type === 'ParenthesizedExpression'))
          init = init.expression as AstNode
        if (node.kind === 'const' && decl.id.type === 'Identifier' && init?.type === 'ArrayExpression')
          literal.add(decl.id.name as string)
        else
          bindOther(decl.id)
      }
    }
    else if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier' || node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      bindOther(node.type.startsWith('Import') ? node.local : node.id)
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      for (const param of node.params as AstNode[])
        bindOther(param.type === 'TSParameterProperty' ? param.parameter : param)
    }
    else if (node.type === 'CatchClause') {
      bindOther(node.param)
    }
  })
  for (const name of other)
    literal.delete(name)
  return literal
}

/** Rewrites free identifier reads inside an AST node while respecting shadowing and property keys; `onJsx` compiles each nested JSX root under the rewrites still unshadowed there. */
function rewriteFreeIdentifiers(
  source: string,
  rootNode: AstNode,
  replacements: ReadonlyMap<string, string>,
  onJsx?: (node: AstNode, rewrites: ReadonlyMap<string, string>) => string,
): string {
  if (replacements.size === 0 && (onJsx === undefined || !containsJsx(rootNode)))
    return source.slice(rootNode.start, rootNode.end)

  const offset = rootNode.start as number
  const editor = new SourceEditor(source.slice(rootNode.start, rootNode.end))

  function visit(node: AstNode | null | undefined, shadowed: Set<string>): void {
    if (!node || typeof node !== 'object')
      return

    if (onJsx !== undefined && isJsxNode(node)) {
      const active = shadowed.size === 0 ? replacements : new Map([...replacements].filter(([k]) => !shadowed.has(k)))
      editor.replace(node.start - offset, node.end - offset, onJsx(node, active))
      return
    }

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
      case 'TSAsExpression':
      case 'TSNonNullExpression':
      case 'TSSatisfiesExpression':
      case 'TSTypeAssertion':
      case 'TSInstantiationExpression': {
        visit(node.expression, shadowed)
        return
      }
      default: {
        // Skip pure TypeScript type annotation nodes
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

  const staticArrays = literalArrayConsts(program)

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

  // How each name a destructuring pattern binds is read from `source` on every access, so reads stay reactive. Plain `{ a }` and `{ a = d }` keys read the property; any other shape re-runs the pattern: `(({ a: { b } }) => b)(source)`.
  function patternReads(pattern: AstNode, source: string): Map<string, string> {
    const reads = new Map<string, string>()
    if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties as AstNode[]) {
        if (prop.type !== 'Property' || prop.computed || prop.key?.type !== 'Identifier')
          continue
        const read = `${source}.${prop.key.name as string}`
        if (prop.value.type === 'Identifier')
          reads.set(prop.value.name as string, read)
        else if (prop.value.type === 'AssignmentPattern' && prop.value.left?.type === 'Identifier')
          reads.set(prop.value.left.name as string, `(${read} === undefined ? ${code.slice(prop.value.right.start, prop.value.right.end)} : ${read})`)
      }
    }
    const names = new Set<string>()
    collectPatternNames(pattern, names)
    const patCode = code.slice(pattern.start, pattern.end)
    for (const name of names) {
      if (!reads.has(name))
        reads.set(name, `((${patCode}) => ${name})(${source})`)
    }
    return reads
  }

  // Client builds keep the `load` binding, so every export form stays valid, and drop its server-only code.
  for (const node of loadDeclarations(program))
    editor.replace(node.start, node.end, node.type === 'FunctionDeclaration' ? `const ${node.id.name as string} = undefined` : 'undefined')

  function extractBlockKeyExpr(block: AstNode): AstNode | undefined {
    let found: AstNode | undefined
    walk(block, (child) => {
      if (found !== undefined)
        return false
      if (child.type === 'ArrowFunctionExpression' || child.type === 'FunctionExpression' || child.type === 'FunctionDeclaration')
        return false
      if (child.type === 'ReturnStatement' && child.argument) {
        const arg = unwrapParens(child.argument as AstNode)
        const k = extractKeyExpr(arg)
        if (k !== undefined) {
          found = k
          return false
        }
      }
      return undefined
    })
    return found
  }

  function compileExpression(node: AstNode, scopeRewrites: ReadonlyMap<string, string>): string {
    return rewriteFreeIdentifiers(code, node, scopeRewrites, compileRootJsx)
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
        propEntries.push(`children: ${JSON.stringify(decodeHtmlEntities(cleanJsxText(child.value as string)))}`)
      else if (isJsxNode(child))
        propEntries.push(`get children() { return ${compileRootJsx(child, scopeRewrites)} }`)
      else if (child.type === 'JSXExpressionContainer')
        propEntries.push(`get children() { return ${compileExpression(child.expression, scopeRewrites)} }`)
    }
    else if (meaningful.length > 1) {
      const items = meaningful.map((c) => {
        if (c.type === 'JSXText')
          return JSON.stringify(decodeHtmlEntities(cleanJsxText(c.value as string)))
        if (isJsxNode(c))
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
    const dynamicTextSlots = new Set<string>() // "parentVar:textIndex" for optional SSR text between <!---->...<!---->
    const dynamicRangeSlots = new Set<string>() // "parentVar:closeIndex" for SSR range between <!---->...<!---->

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
          else if (attr.value?.type === 'JSXExpressionContainer') {
            assertInnerHtmlNotReactObject(attr.value.expression, filename, code)
            ops.push(`${use('effect')}(() => ${use('setInnerHtml')}(${elVar}, ${compileExpression(attr.value.expression, scopeRewrites)}));`)
          }
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
          html += isStringBoolAttr(name) ? ` ${name}="true"` : ` ${name}`
        }
        else if (attr.value.type === 'Literal') {
          if (!isUnsafeUrlAttr(name, attr.value.value))
            html += ` ${name}="${escapeStaticAttr(String(attr.value.value))}"`
        }
        else if (attr.value.type === 'JSXExpressionContainer') {
          const expr = attr.value.expression as AstNode
          const lit = !DOM_PROPS.has(name) && name !== 'style' ? staticLiteral(expr) : { ok: false as const }
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

      const meaningful = filterChildren(el.children as AstNode[])
      let domIndex = 0
      let prevWasStaticText = false

      for (let i = 0; i < meaningful.length; i++) {
        const child = meaningful[i]!
        const isLast = i === meaningful.length - 1

        if (child.type === 'JSXText') {
          html += cleanJsxText(child.value as string)
          if (!prevWasStaticText) {
            domIndex++
            prevWasStaticText = true
          }
          continue
        }

        if (child.type === 'JSXExpressionContainer' && child.expression?.type === 'Literal' && typeof child.expression.value === 'string') {
          html += escapeStaticText(child.expression.value)
          if (!prevWasStaticText) {
            domIndex++
            prevWasStaticText = true
          }
          continue
        }

        prevWasStaticText = false

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
              const prefix = `${placeholderVar}:`
              for (const slot of [...dynamicTextSlots]) {
                if (slot.startsWith(prefix)) {
                  dynamicTextSlots.delete(slot)
                  dynamicTextSlots.add(`${realVar}:${slot.slice(prefix.length)}`)
                }
              }
              for (const slot of [...dynamicRangeSlots]) {
                if (slot.startsWith(prefix)) {
                  dynamicRangeSlots.delete(slot)
                  dynamicRangeSlots.add(`${realVar}:${slot.slice(prefix.length)}`)
                }
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

          // Case 1: Keyed `.map((item, idx?) => <jsx> | { ... return <jsx> })` → `__loop(...)`
          if (
            expr.type === 'CallExpression'
            && expr.callee?.type === 'MemberExpression'
            && !expr.callee.computed
            && expr.callee.property?.name === 'map'
            && expr.arguments?.length === 1
          ) {
            const cb = expr.arguments[0] as AstNode
            const cbBody = cb.body?.type === 'ParenthesizedExpression' ? cb.body.expression : cb.body
            const isJsxBody = isJsxNode(cbBody)
            const isBlockJsxBody = cbBody?.type === 'BlockStatement' && containsJsx(cbBody)
            if (
              (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression')
              && (isJsxBody || isBlockJsxBody)
            ) {
              const loopSkip = domIndex
              const anchorVar = isLast ? 'null' : requestChild(elVar, domIndex)
              if (!isLast) {
                html += '<!---->'
                domIndex++
              }

              const eachCode = compileExpression(expr.callee.object, scopeRewrites)
              const params = cb.params as AstNode[]
              const firstParam = params[0]
              const idxParam = params[1]?.type === 'Identifier' ? params[1].name as string : undefined
              const skipArg = loopSkip > 0 ? `, ${loopSkip}` : ''

              // Fast path: a const array literal (e.g. `NAV.map(...)`) renders once through `eachStatic`, without the keyed reconciler.
              const isStaticArr = expr.callee.object.type === 'Identifier' && staticArrays.has(expr.callee.object.name as string) && !scopeRewrites.has(expr.callee.object.name as string)
              if (isStaticArr) {
                const rawParams = params.map(p => code.slice(p.start, p.end)).join(', ')
                const shadowed = withoutBindings(scopeRewrites, params)
                const rowBody = isJsxBody ? compileRootJsx(cbBody, shadowed) : compileExpression(cbBody, shadowed)
                ops.push(`${use('eachStatic')}(${elVar}, ${anchorVar}, ${eachCode}, (${rawParams}) => ${rowBody}${skipArg});`)
                continue
              }

              const keyAst = isJsxBody ? extractKeyExpr(cbBody) : extractBlockKeyExpr(cbBody)

              const rowSig = freshVar('_r')
              const idxSig = idxParam !== undefined ? freshVar('_i') : undefined
              const rowRewrites = new Map(scopeRewrites)
              let keyFn: string

              const keyRewrites = withoutBindings(scopeRewrites, params)

              if (firstParam !== undefined && firstParam.type !== 'Identifier') {
                const patCode = code.slice(firstParam.start, firstParam.end)
                keyFn = keyAst !== undefined
                  ? `(${patCode}${idxParam ? `, ${idxParam}` : ''}) => ${compileExpression(keyAst, keyRewrites)}`
                  : `(_item) => _item`
                for (const [name, read] of patternReads(firstParam, `${rowSig}.value`))
                  rowRewrites.set(name, read)
              }
              else {
                const itemParam = firstParam?.type === 'Identifier' ? firstParam.name as string : '_item'
                keyFn = keyAst !== undefined
                  ? `(${itemParam}${idxParam ? `, ${idxParam}` : ''}) => ${compileExpression(keyAst, keyRewrites)}`
                  : `(${itemParam}) => ${itemParam}`
                rowRewrites.set(itemParam, `${rowSig}.value`)
              }
              if (idxParam !== undefined && idxSig !== undefined)
                rowRewrites.set(idxParam, `${idxSig}.value`)

              const rowBody = isJsxBody ? compileRootJsx(cbBody, rowRewrites) : compileExpression(cbBody, rowRewrites)
              const rowParams = idxSig !== undefined ? `${rowSig}, ${idxSig}` : rowSig
              ops.push(`${use('loop')}(${elVar}, ${anchorVar}, () => ${eachCode}, ${keyFn}, (${rowParams}) => ${rowBody}${skipArg});`)
              continue
            }
          }

          // Case 2: `cond && <jsx>` → `__show(...)`
          if (expr.type === 'LogicalExpression' && expr.operator === '&&') {
            const right = unwrapParens(expr.right)
            if (isJsxNode(right)) {
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
            if (isJsxNode(consNode) || isJsxNode(altNode)) {
              const anchorVar = isLast ? 'null' : requestChild(elVar, domIndex)
              if (!isLast) {
                html += '<!---->'
                domIndex++
              }
              const whenCode = compileExpression(expr.test, scopeRewrites)
              const trueCode = isJsxNode(consNode)
                ? compileRootJsx(consNode, scopeRewrites)
                : compileExpression(consNode, scopeRewrites)
              const falseCode = isJsxNode(altNode)
                ? compileRootJsx(altNode, scopeRewrites)
                : compileExpression(altNode, scopeRewrites)
              ops.push(`${use('show')}(${elVar}, ${anchorVar}, () => ${whenCode}, () => ${trueCode}, () => ${falseCode});`)
              continue
            }
          }

          // Case 4: Dynamic children slot / Node insertion (`{children}`, `{props.children}`, JSX expressions, or call expressions)
          const isChildrenExpr = (expr.type === 'Identifier' && expr.name === 'children')
            || (expr.type === 'MemberExpression' && !expr.computed && expr.property?.name === 'children')
          const exprCode = compileExpression(expr, scopeRewrites)
          if (isChildrenExpr || containsJsx(expr) || mayReturnNode(expr)) {
            if (meaningful.length === 1) {
              ops.push(`${use('insert')}(${elVar}, () => ${exprCode}, null, null);`)
            }
            else if (isLast) {
              const startVar = requestChild(elVar, domIndex)
              html += '<!---->'
              domIndex++
              ops.push(`${use('insert')}(${elVar}, () => ${exprCode}, null, ${startVar});`)
            }
            else {
              const startVar = requestChild(elVar, domIndex)
              const endVar = requestChild(elVar, domIndex + 1)
              html += '<!----><!---->'
              dynamicRangeSlots.add(`${elVar}:${domIndex + 1}`)
              domIndex += 2
              ops.push(`${use('insert')}(${elVar}, () => ${exprCode}, ${endVar}, ${startVar});`)
            }
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
            // Sibling dynamic child: open comment + optional text (+ closing comment if followed by more siblings)
            const markerVar = requestChild(elVar, domIndex)
            if (isLast) {
              html += '<!----> '
              domIndex += 2
            }
            else {
              html += '<!----> <!---->'
              dynamicTextSlots.add(`${elVar}:${domIndex + 1}`)
              domIndex += 3
            }
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
        let pos: number
        if (prevVar === undefined) {
          expr = `${pVar}.firstChild`
          pos = 0
        }
        else {
          expr = prevVar
          pos = prevIdx
        }
        while (pos < index) {
          if (dynamicTextSlots.has(`${pVar}:${pos + 1}`) && pos + 2 <= index) {
            expr = `${use('skipText')}(${expr})`
            pos += 2
          }
          else if (dynamicRangeSlots.has(`${pVar}:${pos + 1}`)) {
            expr = `${use('skipRange')}(${expr})`
            pos += 1
          }
          else {
            expr = `${expr}.nextSibling`
            pos += 1
          }
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
        if (isJsxNode(child))
          return compileRootJsx(child, scopeRewrites)
        if (child.type === 'JSXText')
          return `document.createTextNode(${JSON.stringify(decodeHtmlEntities(cleanJsxText(child.value as string)))})`
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
    if (!containsJsx(fn.body))
      return

    const propRewrites = new Map<string, string>()
    const firstParam = (fn.params as AstNode[])[0]
    if (firstParam !== undefined && firstParam.type === 'ObjectPattern') {
      const pVar = '__p'
      const typeAnn = firstParam.typeAnnotation ? code.slice(firstParam.typeAnnotation.start, firstParam.typeAnnotation.end) : ''
      editor.replace(firstParam.start, firstParam.end, `${pVar}${typeAnn}`)

      for (const [name, read] of patternReads(firstParam, pVar))
        propRewrites.set(name, read)

      // A rest beside static keys stays a live view of the props; beside a computed key it keeps the pattern's own copy.
      const extractedKeys: string[] = []
      let restName: string | undefined
      let staticKeys = true
      for (const prop of firstParam.properties as AstNode[]) {
        if (prop.type === 'RestElement')
          restName = prop.argument?.type === 'Identifier' ? prop.argument.name as string : undefined
        else if (!prop.computed && prop.key?.type === 'Identifier')
          extractedKeys.push(prop.key.name as string)
        else if (!prop.computed && typeof prop.key?.value === 'string')
          extractedKeys.push(prop.key.value)
        else
          staticKeys = false
      }
      if (restName !== undefined && staticKeys)
        propRewrites.set(restName, `${use('omit')}(${pVar}, ${JSON.stringify(extractedKeys)})`)
    }

    // Rewrite prop reads in non-JSX statements of the function body, and compile JSX roots with propRewrites
    if (propRewrites.size > 0 && fn.body?.type === 'BlockStatement') {
      const shadowed = new Set<string>()
      for (const stmt of fn.body.body as AstNode[]) {
        const active = new Map<string, string>()
        for (const [k, v] of propRewrites) {
          if (!shadowed.has(k))
            active.set(k, v)
        }
        // A statement holding JSX also reads props around it (`if (on) return <b/>`): compile both in one pass.
        if (active.size > 0 || containsJsx(stmt))
          editor.replace(stmt.start, stmt.end, compileExpression(stmt, active))
        if (stmt.type === 'VariableDeclaration') {
          for (const d of stmt.declarations as AstNode[])
            collectPatternNames(d.id, shadowed)
        }
      }
    }
    else {
      editor.replace(fn.body.start, fn.body.end, compileExpression(fn.body, propRewrites))
    }
  }

  walk(program, (node) => {
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

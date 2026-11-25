// Kay v2 Client DOM compiler: compiles TSX to hoisted template() clones, child-path walks,
// delegated events, compiler-safe destructured props, reactive spreads, and shared balanced hydration markers.

import type {
  ArrowFunctionExpression,
  BlockStatement,
  Function as OxcFunction,
  JSXElement,
  JSXFragment,
  Node,
  ObjectPattern,
  ParamPattern,
  Program,
} from 'oxc-parser'
import type { ModuleAnalysis } from './analyze'
import { analyzeModule, loadDeclarations, parseTsx, walk } from './analyze'
import { SourceEditor } from './patch'
import {
  classifyJsxChild,
  cleanJsxText,
  collectPatternNames,
  containsJsx,
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
  unwrapParens,
  unwrapTsExpr,
  VOID_ELEMENTS,
} from './shared'

const SVG_CHILD_TAGS = new Set([
  'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse',
  'g', 'defs', 'use', 'text', 'tspan', 'textPath', 'clipPath', 'mask',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'symbol', 'image',
  'marker', 'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer',
  'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap',
  'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG',
  'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode',
  'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
  'feSpotLight', 'feTile', 'feTurbulence', 'foreignObject', 'animate',
  'animateMotion', 'animateTransform', 'set', 'mpath', 'desc', 'metadata', 'switch',
])

const DELEGATED_EVENTS = new Set([
  'beforeinput', 'click', 'dblclick', 'focusin', 'focusout',
  'input', 'keydown', 'keyup', 'mousedown', 'mouseup',
  'pointerdown', 'pointerup', 'touchstart', 'touchend',
])

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
  eacute: '\u00E9', egrave: '\u00E8', ecirc: '\u00EA', agrave: '\u00E0',
  acirc: '\u00E2', ccedil: '\u00E7', ocirc: '\u00F4', ugrave: '\u00F9',
  ucirc: '\u00FB', iuml: '\u00EF', icirc: '\u00EE', oelig: '\u0153',
  Eacute: '\u00C9', Egrave: '\u00C8', Agrave: '\u00C0', Ccedil: '\u00C7',
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

export interface CompileDomOptions {
  analysis?: ModuleAnalysis | undefined
}

export interface CompileDomResult {
  code: string
  analysis: ModuleAnalysis
}

function withoutBindings(rewrites: ReadonlyMap<string, string>, patterns: readonly Node[]): Map<string, string> {
  const names = new Set<string>()
  for (const pattern of patterns)
    collectPatternNames(pattern, names)
  const kept = new Map(rewrites)
  for (const name of names)
    kept.delete(name)
  return kept
}

// Names whose every binding in the file is a `const` holding an array literal: only those can be looped once without tracking.
function literalArrayConsts(program: Program): Set<string> {
  const literal = new Set<string>()
  const other = new Set<string>()
  const bindOther = (pattern: Node | null | undefined): void => {
    if (pattern !== null && pattern !== undefined)
      collectPatternNames(pattern, other)
  }
  walk(program, (node) => {
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        const init = decl.init !== null ? unwrapTsExpr(decl.init) : null
        if (node.kind === 'const' && decl.id.type === 'Identifier' && init?.type === 'ArrayExpression')
          literal.add(decl.id.name)
        else
          bindOther(decl.id)
      }
    }
    else if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') {
      bindOther(node.local)
    }
    else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      bindOther(node.id)
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      for (const param of node.params)
        bindOther(param)
    }
    else if (node.type === 'CatchClause') {
      bindOther(node.param)
    }
  })
  for (const name of other)
    literal.delete(name)
  return literal
}

/** Collects free identifier references inside a node (ignoring shadowed locals and property keys). */
function referencesAny(rootNode: Node, names: ReadonlySet<string>): boolean {
  if (names.size === 0)
    return false
  let found = false
  function visit(node: Node | null | undefined, shadowed: Set<string>): void {
    if (found || node === null || node === undefined)
      return
    switch (node.type) {
      case 'Identifier':
        if (!shadowed.has(node.name) && names.has(node.name))
          found = true
        return
      case 'MemberExpression':
        visit(node.object, shadowed)
        if (node.computed)
          visit(node.property, shadowed)
        return
      case 'Property':
        if (node.computed)
          visit(node.key, shadowed)
        visit(node.value, shadowed)
        return
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
      case 'FunctionDeclaration': {
        const next = new Set(shadowed)
        if (node.type !== 'ArrowFunctionExpression' && node.id !== null)
          next.add(node.id.name)
        for (const p of node.params)
          collectPatternNames(p, next)
        visit(node.body, next)
        return
      }
      case 'BlockStatement': {
        const next = new Set(shadowed)
        for (const stmt of node.body) {
          if (stmt.type === 'VariableDeclaration') {
            for (const d of stmt.declarations) {
              visit(d.init, next)
              collectPatternNames(d.id, next)
            }
          }
          else {
            visit(stmt, next)
          }
        }
        return
      }
      default: {
        if (node.type.startsWith('TS'))
          return
        for (const [k, v] of Object.entries(node)) {
          if (k === 'start' || k === 'end' || k === 'type')
            continue
          if (Array.isArray(v)) {
            for (const item of v) {
              if (item !== null && typeof item === 'object' && 'type' in item)
                visit(item as Node, shadowed)
            }
          }
          else if (v !== null && typeof v === 'object' && 'type' in v) {
            visit(v as Node, shadowed)
          }
        }
      }
    }
  }
  visit(rootNode, new Set())
  return found
}

/** Rewrites free identifier reads inside an AST node while respecting lexical scopes, class/object keys, labels, and nested JSX/components. */
function rewriteFreeIdentifiers(
  source: string,
  rootNode: Node,
  replacements: ReadonlyMap<string, string>,
  onJsx?: (node: JSXElement | JSXFragment, rewrites: ReadonlyMap<string, string>) => string,
  onFunction?: (fn: ArrowFunctionExpression | OxcFunction, rewrites: ReadonlyMap<string, string>) => string | undefined,
): string {
  if (replacements.size === 0 && (onJsx === undefined || !containsJsx(rootNode)))
    return source.slice(rootNode.start, rootNode.end)

  const offset = rootNode.start
  const editor = new SourceEditor(source.slice(rootNode.start, rootNode.end))

  function visitPatternDefaults(pattern: Node | null | undefined, shadowed: Set<string>): void {
    if (pattern === null || pattern === undefined)
      return
    switch (pattern.type) {
      case 'AssignmentPattern':
        visitPatternDefaults(pattern.left, shadowed)
        visit(pattern.right, shadowed)
        return
      case 'RestElement':
        visitPatternDefaults(pattern.argument, shadowed)
        return
      case 'TSParameterProperty':
        visitPatternDefaults(pattern.parameter, shadowed)
        return
      case 'ArrayPattern':
        for (const el of pattern.elements)
          visitPatternDefaults(el, shadowed)
        return
      case 'ObjectPattern':
        for (const prop of pattern.properties) {
          if (prop.type === 'RestElement') {
            visitPatternDefaults(prop.argument, shadowed)
          }
          else {
            if (prop.computed)
              visit(prop.key, shadowed)
            visitPatternDefaults(prop.value, shadowed)
          }
        }
    }
  }

  function activeMap(shadowed: Set<string>): ReadonlyMap<string, string> {
    return shadowed.size === 0 ? replacements : new Map([...replacements].filter(([k]) => !shadowed.has(k)))
  }

  function visit(node: Node | null | undefined, shadowed: Set<string>): void {
    if (node === null || node === undefined)
      return

    if (onJsx !== undefined && isJsxNode(node)) {
      editor.replace(node.start - offset, node.end - offset, onJsx(node, activeMap(shadowed)))
      return
    }

    switch (node.type) {
      case 'Identifier': {
        const name = node.name
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
      case 'MetaProperty':
      case 'BreakStatement':
      case 'ContinueStatement':
        return
      case 'LabeledStatement': {
        visit(node.body, shadowed)
        return
      }
      case 'Property': {
        if (node.computed)
          visit(node.key, shadowed)
        if (node.shorthand && node.value.type === 'Identifier') {
          const name = node.value.name
          if (!shadowed.has(name) && replacements.has(name)) {
            editor.replace(node.start - offset, node.end - offset, `${name}: ${replacements.get(name)}`)
            return
          }
        }
        visit(node.value, shadowed)
        return
      }
      case 'MethodDefinition':
      case 'PropertyDefinition': {
        if (node.computed)
          visit(node.key, shadowed)
        visit(node.value, shadowed)
        return
      }
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const next = new Set(shadowed)
        if (node.id !== null)
          next.add(node.id.name)
        visit(node.superClass, shadowed)
        visit(node.body, next)
        return
      }
      case 'CatchClause': {
        const next = new Set(shadowed)
        visitPatternDefaults(node.param, next)
        collectPatternNames(node.param, next)
        visit(node.body, next)
        return
      }
      case 'ForStatement': {
        const next = new Set(shadowed)
        if (node.init !== null) {
          if (node.init.type === 'VariableDeclaration') {
            for (const d of node.init.declarations) {
              visit(d.init, next)
              visitPatternDefaults(d.id, next)
              collectPatternNames(d.id, next)
            }
          }
          else {
            visit(node.init, next)
          }
        }
        visit(node.test, next)
        visit(node.update, next)
        visit(node.body, next)
        return
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        visit(node.right, shadowed)
        const next = new Set(shadowed)
        if (node.left.type === 'VariableDeclaration') {
          for (const d of node.left.declarations) {
            visitPatternDefaults(d.id, next)
            collectPatternNames(d.id, next)
          }
        }
        else {
          visit(node.left, next)
        }
        visit(node.body, next)
        return
      }
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
      case 'FunctionDeclaration': {
        if (node !== rootNode && onFunction !== undefined) {
          const compiled = onFunction(node, activeMap(shadowed))
          if (compiled !== undefined) {
            editor.replace(node.start - offset, node.end - offset, compiled)
            return
          }
        }
        const nextShadow = new Set(shadowed)
        if (node.type !== 'ArrowFunctionExpression' && node.id !== null)
          nextShadow.add(node.id.name)
        for (const p of node.params) {
          visitPatternDefaults(p, nextShadow)
          collectPatternNames(p, nextShadow)
        }
        visit(node.body, nextShadow)
        return
      }
      case 'BlockStatement': {
        const nextShadow = new Set(shadowed)
        for (const stmt of node.body) {
          if (stmt.type === 'FunctionDeclaration' && stmt.id !== null)
            nextShadow.add(stmt.id.name)
          else if (stmt.type === 'ClassDeclaration' && stmt.id !== null)
            nextShadow.add(stmt.id.name)
        }
        for (const stmt of node.body) {
          if (stmt.type === 'VariableDeclaration') {
            for (const d of stmt.declarations) {
              visit(d.init, nextShadow)
              visitPatternDefaults(d.id, nextShadow)
              collectPatternNames(d.id, nextShadow)
            }
          }
          else {
            visit(stmt, nextShadow)
          }
        }
        return
      }
      case 'VariableDeclarator': {
        visit(node.init, shadowed)
        visitPatternDefaults(node.id, shadowed)
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
        if (node.type.startsWith('TS'))
          return
        for (const [key, val] of Object.entries(node)) {
          if (key === 'start' || key === 'end' || key === 'type')
            continue
          if (Array.isArray(val)) {
            for (let i = 0; i < val.length; i++) {
              const item = val[i]
              if (item !== null && typeof item === 'object' && 'type' in item)
                visit(item as Node, shadowed)
            }
          }
          else if (val !== null && typeof val === 'object' && 'type' in val) {
            visit(val as Node, shadowed)
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
  const loadNodes = new Set<Node>(loadDeclarations(program))

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

  // How each name a destructuring pattern binds is read from `source` on every access, so reads stay reactive.
  function patternReads(pattern: Node, source: string, outerRewrites: ReadonlyMap<string, string>): Map<string, string> {
    const reads = new Map<string, string>()
    const running = new Map(outerRewrites)
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
          const expr = `(${read} === undefined ? ${simpleDef ? defExpr : `(${defExpr})`} : ${read})`
          reads.set(prop.value.left.name, expr)
          running.set(prop.value.left.name, expr)
        }
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
  for (const node of loadNodes) {
    if (node.type === 'FunctionDeclaration' && node.id !== null)
      editor.replace(node.start, node.end, `const ${node.id.name} = undefined`)
    else
      editor.replace(node.start, node.end, 'undefined')
  }

  function extractKeyExpr(jsxEl: Node): Node | undefined {
    if (jsxEl.type !== 'JSXElement')
      return undefined
    for (const attr of jsxEl.openingElement.attributes) {
      if (attr.type === 'JSXAttribute' && attr.name.type === 'JSXIdentifier' && attr.name.name === 'key') {
        if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression')
          return attr.value.expression
        if (attr.value?.type === 'Literal')
          return attr.value
      }
    }
    return undefined
  }

  function extractBlockKeyExpr(block: BlockStatement): Node | undefined {
    const blockLocals = new Set<string>()
    for (const stmt of block.body) {
      if (stmt.type === 'VariableDeclaration') {
        for (const d of stmt.declarations)
          collectPatternNames(d.id, blockLocals)
      }
      else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id !== null) {
        blockLocals.add(stmt.id.name)
      }
    }
    let found: Node | undefined
    walk(block, (child) => {
      if (found !== undefined)
        return false
      if (child.type === 'ArrowFunctionExpression' || child.type === 'FunctionExpression' || child.type === 'FunctionDeclaration')
        return false
      if (child.type === 'ReturnStatement' && child.argument !== null) {
        const arg = unwrapParens(child.argument)
        const k = extractKeyExpr(arg)
        // Only hoist key expressions that don't depend on block-local variables.
        if (k !== undefined && !referencesAny(k, blockLocals)) {
          found = k
          return false
        }
      }
      return undefined
    })
    return found
  }

  function compileNestedComponent(fn: ArrowFunctionExpression | OxcFunction, outerRewrites: ReadonlyMap<string, string>): string | undefined {
    if (!containsJsx(fn.body))
      return undefined
    const firstParam = fn.params[0]
    const destructured = extractDestructuredParam(firstParam)
    if (destructured === undefined)
      return undefined
    return buildCompiledFunction(fn, outerRewrites)
  }

  function compileExpression(node: Node, scopeRewrites: ReadonlyMap<string, string>): string {
    return rewriteFreeIdentifiers(code, node, scopeRewrites, compileRootJsx, compileNestedComponent)
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
        // Reactive getter for dynamic expressions; plain property for literals and inline functions.
        const isStatic = expr.type === 'Literal'
          || expr.type === 'ArrowFunctionExpression'
          || expr.type === 'FunctionExpression'
        if (isStatic)
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

    const walkPlan: { parentVar: string, index: number, varName: string }[] = []
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
      const slots = meaningful.map(c => classifyJsxChild(c)).filter(s => s !== undefined)
      const hasSiblings = slots.length > 1
      let domIndex = 0
      let prevWasStaticText = false
      let hadVariableRange = false

      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]!
        const isLast = i === slots.length - 1

        if (slot.kind === 'static-text') {
          if (rawTextTag !== undefined)
            html += escapeRawText(slot.text, rawTextTag)
          else
            html += slot.fromLiteral ? escapeStaticText(slot.text) : slot.text
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
        if (isNodeCapableExpr(slot.expr)) {
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

      html += `</${tag}>`
      return html
    }

    const html = buildHtml(rootEl, rootVar)
    const rootTag = jsxTagName(rootEl.openingElement.name)
    const tmplName = `_t${templates.length}`
    templates.push({ name: tmplName, html, isSvg: SVG_CHILD_TAGS.has(rootTag) })

    // Emit parent->child sibling walks grouped by parentVar (breadth-first / parent-first order)
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

    const emittedParents = new Set<string>([rootVar])
    const queue = [rootVar]
    while (queue.length > 0) {
      const pVar = queue.shift()!
      const list = byParent.get(pVar)
      if (list === undefined)
        continue
      list.sort((a, b) => a.index - b.index)

      const tSlots = textSlotsByParent.get(pVar)
      const rSlots = rangeSlotsByParent.get(pVar)
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
          if (tSlots?.has(pos + 1) && pos + 2 <= index) {
            expr = `${use('skipText')}(${expr})`
            pos += 2
          }
          else if (rSlots?.has(pos + 1)) {
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
          return `document.createTextNode(${JSON.stringify(decodeHtmlEntities(cleanJsxText(only.value)))})`
        if (only.type === 'JSXExpressionContainer' && only.expression.type !== 'JSXEmptyExpression') {
          const exprCode = compileExpression(only.expression, scopeRewrites)
          return `(() => { const _f = document.createDocumentFragment(); ${use('insert')}(_f, () => (${exprCode}), null, null); return _f; })()`
        }
      }

      const items = meaningful.map((child) => {
        if (isJsxNode(child))
          return compileRootJsx(child, scopeRewrites)
        if (child.type === 'JSXText')
          return `document.createTextNode(${JSON.stringify(decodeHtmlEntities(cleanJsxText(child.value)))})`
        if (child.type === 'JSXExpressionContainer' && child.expression.type !== 'JSXEmptyExpression') {
          const exprCode = compileExpression(child.expression, scopeRewrites)
          if (isNodeCapableExpr(child.expression))
            return `(() => { const _f = document.createDocumentFragment(); ${use('insert')}(_f, () => (${exprCode}), null, null); return _f; })()`
          return `(() => { const _t = document.createTextNode(""); ${use('effect')}(() => ${use('setText')}(_t, (${exprCode}))); return _t; })()`
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
  ): Map<string, string> {
    const propRewrites = new Map(outerRewrites)
    for (const [name, read] of patternReads(destructured.pattern, pVar, outerRewrites))
      propRewrites.set(name, read)

    const extractedKeys: string[] = []
    let restName: string | undefined
    let staticKeys = true
    for (const prop of destructured.pattern.properties) {
      if (prop.type === 'RestElement')
        restName = prop.argument.type === 'Identifier' ? prop.argument.name : undefined
      else if (!prop.computed && prop.key.type === 'Identifier')
        extractedKeys.push(prop.key.name)
      else if (!prop.computed && prop.key.type === 'Literal' && typeof prop.key.value === 'string')
        extractedKeys.push(prop.key.value)
      else
        staticKeys = false
    }
    if (restName !== undefined && staticKeys)
      propRewrites.set(restName, `${use('omit')}(${pVar}, ${JSON.stringify(extractedKeys)})`)
    return propRewrites
  }

  function buildCompiledFunction(fn: ArrowFunctionExpression | OxcFunction, outerRewrites: ReadonlyMap<string, string>): string {
    const fnEditor = new SourceEditor(code.slice(fn.start, fn.end))
    const offset = fn.start
    const destructured = extractDestructuredParam(fn.params[0])
    const pVar = freshVar('__p')
    let propRewrites = new Map(outerRewrites)

    if (destructured !== undefined) {
      const defSuffix = destructured.defaultExpr !== undefined
        ? ` = ${compileExpression(destructured.defaultExpr, outerRewrites)}`
        : ''
      fnEditor.replace(destructured.replaceStart - offset, destructured.replaceEnd - offset, `${pVar}${destructured.typeAnn}${defSuffix}`)
      propRewrites = computePropRewrites(destructured, pVar, outerRewrites)
    }

    if (fn.body !== null)
      fnEditor.replace(fn.body.start - offset, fn.body.end - offset, compileExpression(fn.body, propRewrites))
    return fnEditor.toString()
  }

  // Handle top-level component functions with destructured props + JSX compilation
  function processFunction(fn: ArrowFunctionExpression | OxcFunction): void {
    if (fn.body === null || !containsJsx(fn.body))
      return

    const destructured = extractDestructuredParam(fn.params[0])
    let propRewrites = new Map<string, string>()

    if (destructured !== undefined) {
      const pVar = '__p'
      const defSuffix = destructured.defaultExpr !== undefined
        ? ` = ${compileExpression(destructured.defaultExpr, new Map())}`
        : ''
      editor.replace(destructured.replaceStart, destructured.replaceEnd, `${pVar}${destructured.typeAnn}${defSuffix}`)
      propRewrites = computePropRewrites(destructured, pVar, new Map())
    }

    if (propRewrites.size > 0 && fn.body.type === 'BlockStatement') {
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
        if (active.size > 0 || containsJsx(stmt))
          editor.replace(stmt.start, stmt.end, compileExpression(stmt, active))
        if (stmt.type === 'VariableDeclaration') {
          for (const d of stmt.declarations)
            collectPatternNames(d.id, shadowed)
        }
      }
    }
    else {
      editor.replace(fn.body.start, fn.body.end, compileExpression(fn.body, propRewrites))
    }
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

  // Emit imports, hoisted templates, and delegated events
  let header = ''
  if (templates.length > 0)
    use('template')
  if (delegatedEvents.size > 0)
    use('delegate')

  if (used.size > 0) {
    const hasLoop = used.delete('loop')
    const EXTRA_HELPERS = ['insert', 'mergeProps', 'omit', 'setInnerHtml', 'show', 'spread']
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

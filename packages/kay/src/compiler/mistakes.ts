// Refuses JSX that compiles but does the wrong thing, mostly habits from React, Solid and Astro, with an error naming the fix.

import type { JSXAttribute, JSXAttributeItem, JSXElement, Node, Program } from 'oxc-parser'
import type { ServerOnlyInIsland } from './interactivity'
import { visitorKeys } from 'oxc-parser'
import { walk } from './ast'
import { EVENT_ATTR, filterMeaningfulChildren, isComponentTag, jsxTagName, unwrapParens, VOID_ELEMENTS } from './shared'

// The kay prop for each DOM event, keyed by the event name kay binds (`onKeyDown` binds `keydown`).
const EVENT_PROPS = new Map(Object.entries({
  abort: 'onAbort', animationcancel: 'onAnimationCancel', animationend: 'onAnimationEnd', animationiteration: 'onAnimationIteration', animationstart: 'onAnimationStart',
  auxclick: 'onAuxClick', beforeinput: 'onBeforeInput', beforetoggle: 'onBeforeToggle', blur: 'onBlur', cancel: 'onCancel',
  canplay: 'onCanPlay', canplaythrough: 'onCanPlayThrough', change: 'onChange', click: 'onClick', close: 'onClose',
  compositionend: 'onCompositionEnd', compositionstart: 'onCompositionStart', compositionupdate: 'onCompositionUpdate',
  contextmenu: 'onContextMenu', copy: 'onCopy', cut: 'onCut', dblclick: 'onDblClick', drag: 'onDrag', dragend: 'onDragEnd',
  dragenter: 'onDragEnter', dragleave: 'onDragLeave', dragover: 'onDragOver', dragstart: 'onDragStart', drop: 'onDrop',
  durationchange: 'onDurationChange', emptied: 'onEmptied', ended: 'onEnded', error: 'onError', focus: 'onFocus',
  focusin: 'onFocusIn', focusout: 'onFocusOut', formdata: 'onFormData', gotpointercapture: 'onGotPointerCapture',
  input: 'onInput', invalid: 'onInvalid', keydown: 'onKeyDown', keypress: 'onKeyPress', keyup: 'onKeyUp', load: 'onLoad',
  loadeddata: 'onLoadedData', loadedmetadata: 'onLoadedMetadata', loadstart: 'onLoadStart',
  lostpointercapture: 'onLostPointerCapture', mousedown: 'onMouseDown', mouseenter: 'onMouseEnter', mouseleave: 'onMouseLeave',
  mousemove: 'onMouseMove', mouseout: 'onMouseOut', mouseover: 'onMouseOver', mouseup: 'onMouseUp', paste: 'onPaste',
  pause: 'onPause', play: 'onPlay', playing: 'onPlaying', pointercancel: 'onPointerCancel', pointerdown: 'onPointerDown',
  pointerenter: 'onPointerEnter', pointerleave: 'onPointerLeave', pointermove: 'onPointerMove', pointerout: 'onPointerOut',
  pointerover: 'onPointerOver', pointerup: 'onPointerUp', progress: 'onProgress', ratechange: 'onRateChange', reset: 'onReset',
  resize: 'onResize', scroll: 'onScroll', scrollend: 'onScrollEnd', securitypolicyviolation: 'onSecurityPolicyViolation',
  seeked: 'onSeeked', seeking: 'onSeeking', select: 'onSelect', selectionchange: 'onSelectionChange',
  selectstart: 'onSelectStart', slotchange: 'onSlotChange', stalled: 'onStalled', submit: 'onSubmit', suspend: 'onSuspend',
  timeupdate: 'onTimeUpdate', toggle: 'onToggle', touchcancel: 'onTouchCancel', touchend: 'onTouchEnd',
  touchmove: 'onTouchMove', touchstart: 'onTouchStart', transitioncancel: 'onTransitionCancel',
  transitionend: 'onTransitionEnd', transitionrun: 'onTransitionRun', transitionstart: 'onTransitionStart',
  volumechange: 'onVolumeChange', waiting: 'onWaiting', wheel: 'onWheel',
  afterprint: 'onAfterPrint', beforeprint: 'onBeforePrint', beforeunload: 'onBeforeUnload', hashchange: 'onHashChange',
  message: 'onMessage', offline: 'onOffline', online: 'onOnline', pagehide: 'onPageHide', pageshow: 'onPageShow',
  popstate: 'onPopState', storage: 'onStorage', unload: 'onUnload', fullscreenchange: 'onFullscreenChange',
  fullscreenerror: 'onFullscreenError', loadend: 'onLoadEnd', search: 'onSearch', beforematch: 'onBeforeMatch',
  command: 'onCommand', cuechange: 'onCueChange', encrypted: 'onEncrypted', waitingforkey: 'onWaitingForKey',
  pointerrawupdate: 'onPointerRawUpdate', contextlost: 'onContextLost', contextrestored: 'onContextRestored',
  contentvisibilityautostatechange: 'onContentVisibilityAutoStateChange',
}))

// React names whose DOM event is spelled differently.
const RENAMED_EVENTS = new Map([['doubleclick', 'dblclick']])
const CAPTURE_SUFFIX = 'capture'
const LOWERCASE_EVENT = /^on[a-z]/

function eventProp(event: string): string {
  return EVENT_PROPS.get(event) ?? `on${event.charAt(0).toUpperCase()}${event.slice(1)}`
}

export function mistake(what: string, filename: string, fix: string): Error {
  return new Error(`kay compiler: ${what} in ${filename}: ${fix}.`)
}

export function islandRemoved(filename: string): Error {
  return mistake('island()', filename, 'it is gone; write export const hydrate = \'visible\' in the component\'s file, or set $hydrate where it renders')
}

// `<Head>` and `<Suspense>` run during server rendering only, so in an island they never update.
export function serverOnlyTagError(filename: string, { tag, island, reason }: ServerOnlyInIsland): Error {
  return mistake(`<${tag}> in an island`, filename, `${island} is an island because it ${reason}; move <${tag}> to the page or a layout, outside any component with state or handlers`)
}

const BARE_KAY_RE = /^kay(?:\/|$)/

/** Refuses the bare `kay` spelling kay v1 used: v2 is imported as `@kayjs/kay`. */
export function assertScopedKayImport(source: string, filename: string): void {
  if (BARE_KAY_RE.test(source))
    throw mistake(`import from '${source}'`, filename, `write '@kayjs/${source}' (kay upgrade rewrites every import)`)
}

const HYDRATE_MODES = new Set(['load', 'visible', 'idle', 'interaction', 'client'])
const MEDIA_MODE = /^media\(.+\)$/

/** Throws on a hydrate mode the browser runtime would silently treat as `load`; `*` stands for a mode picked at runtime. */
export function checkHydrateMode(mode: string, what: string, filename: string): void {
  if (mode !== '*' && !HYDRATE_MODES.has(mode) && !MEDIA_MODE.test(mode))
    throw mistake(what, filename, 'use load, visible, idle, interaction, client or media(<query>)')
}

function checkHandler(name: string, value: JSXAttribute['value'], filename: string, code: string): void {
  if (value === null)
    throw mistake(name, filename, `pass a function, ${name}={() => ...}`)
  if (value.type === 'Literal')
    throw mistake(`${name}="..."`, filename, `pass a function, ${name}={() => ...}`)
  if (value.type !== 'JSXExpressionContainer')
    return
  const expr = unwrapParens(value.expression)
  if ((expr.type === 'Literal' && typeof expr.value === 'string') || expr.type === 'TemplateLiteral')
    throw mistake(`${name}="..."`, filename, `pass a function, ${name}={() => ...}`)
  if (expr.type === 'UpdateExpression' || expr.type === 'AssignmentExpression') {
    const source = code.slice(expr.start, expr.end)
    throw mistake(`${name} runs ${source} at render`, filename, `write ${name}={() => ${source}}`)
  }
}

// SVG presentation attributes React spells in camelCase; SVG is case-sensitive, so the camelCase name sets nothing.
const KEBAB_SVG_ATTRS = new Set([
  'alignment-baseline', 'baseline-shift', 'clip-path', 'clip-rule', 'color-interpolation', 'color-interpolation-filters',
  'dominant-baseline', 'enable-background', 'fill-opacity', 'fill-rule', 'flood-color', 'flood-opacity', 'font-family',
  'font-size', 'font-size-adjust', 'font-stretch', 'font-style', 'font-variant', 'font-weight', 'image-rendering',
  'letter-spacing', 'lighting-color', 'marker-end', 'marker-mid', 'marker-start', 'paint-order', 'pointer-events',
  'shape-rendering', 'stop-color', 'stop-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-width', 'text-anchor', 'text-decoration',
  'text-rendering', 'transform-origin', 'unicode-bidi', 'vector-effect', 'word-spacing', 'writing-mode',
])
const CAMEL_HUMP = /[A-Z]/g
// React's uncontrolled-input props and the attribute each one stands for.
const REACT_DEFAULTS = new Map([['defaultValue', 'value'], ['defaultChecked', 'checked']])
const BOOLEAN_ATTRS = new Set([
  'allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled',
  'formnovalidate', 'hidden', 'inert', 'ismap', 'loop', 'multiple', 'muted', 'nomodule', 'novalidate', 'open',
  'playsinline', 'readonly', 'required', 'reversed', 'selected',
])

function checkRef(value: JSXAttribute['value'], filename: string): void {
  if (value === null)
    throw mistake('ref', filename, 'pass a function, ref={el => ...}')
  if (value.type === 'Literal')
    throw mistake('ref="..."', filename, 'pass a function, ref={el => ...}')
  if (value.type === 'JSXExpressionContainer' && unwrapParens(value.expression).type === 'ObjectExpression')
    throw mistake('ref={{ ... }}', filename, 'pass a function, ref={el => ...}, kay has no ref objects')
}

function checkSpelling(name: string, value: JSXAttribute['value'], filename: string): void {
  const kebab = name.replace(CAMEL_HUMP, hump => `-${hump.toLowerCase()}`)
  if (kebab !== name && KEBAB_SVG_ATTRS.has(kebab))
    throw mistake(name, filename, `write ${kebab}={...}, SVG attributes are case-sensitive`)
  if (name === 'xlinkHref')
    throw mistake(name, filename, 'write xlink:href={...}, or href={...}')
  const attribute = REACT_DEFAULTS.get(name)
  if (attribute !== undefined)
    throw mistake(name, filename, `write ${attribute}={...}`)
  if (value?.type === 'Literal' && value.value === 'false' && BOOLEAN_ATTRS.has(name.toLowerCase()))
    throw mistake(`${name}="false"`, filename, `write ${name}={false}, any string turns it on`)
}

// Astro's client: directives and the $hydrate mode each one means.
const CLIENT_DIRECTIVES = new Map([['load', 'load'], ['visible', 'visible'], ['idle', 'idle'], ['only', 'client'], ['media', 'media(<query>)']])
// XML namespaces SVG and MathML really use; every other prefix is a directive from another framework.
const XML_NAMESPACES = new Set(['xlink', 'xml', 'xmlns'])

function checkNamespacedAttribute(namespace: string, name: string, filename: string): void {
  if (XML_NAMESPACES.has(namespace))
    return
  const what = `${namespace}:${name}`
  if (namespace === 'on')
    throw mistake(what, filename, `write ${eventProp(name.toLowerCase())}={...}`)
  if (namespace === 'client')
    throw mistake(what, filename, `write $hydrate="${CLIENT_DIRECTIVES.get(name) ?? 'load'}"`)
  if (what === 'class:list')
    throw mistake(what, filename, 'pass one string to class, joining the names yourself')
  if (what === 'set:html')
    throw mistake(what, filename, 'write innerHTML={...}')
  if (what === 'set:text')
    throw mistake(what, filename, 'write the text as children')
  if (namespace === 'use')
    throw mistake(what, filename, `call ${name} in a ref`)
  if (namespace === 'prop' || namespace === 'attr' || namespace === 'bool')
    throw mistake(what, filename, `write ${name}={...}`)
  throw mistake(what, filename, `kay has no ${namespace}: directives`)
}

// The source of `x` in React's `{{ __html: x }}`, or undefined when the attribute holds something else.
function reactHtmlSource(value: JSXAttribute['value'], code: string): string | undefined {
  if (value?.type !== 'JSXExpressionContainer')
    return undefined
  const expr = unwrapParens(value.expression)
  if (expr.type !== 'ObjectExpression')
    return undefined
  for (const p of expr.properties) {
    if (p.type !== 'Property')
      continue
    const keyName = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : undefined
    if (keyName === '__html')
      return code.slice(p.value.start, p.value.end)
  }
  return undefined
}

function checkInnerHtml(element: JSXElement, tag: string, attr: JSXAttribute, filename: string, code: string): void {
  const html = reactHtmlSource(attr.value, code)
  if (html !== undefined)
    throw mistake('innerHTML={{ __html }}', filename, `write innerHTML={${html}}, kay takes the HTML string itself`)
  if (VOID_ELEMENTS.has(tag))
    throw mistake(`innerHTML on <${tag}>`, filename, 'a void element has no content, drop innerHTML')
  if (filterMeaningfulChildren(element.children).length > 0)
    throw mistake('innerHTML with children', filename, 'keep one, the children or innerHTML')
}

function checkElementAttribute(attr: JSXAttribute, isCustomElement: boolean, filename: string, code: string): void {
  if (attr.name.type !== 'JSXIdentifier')
    return
  const name = attr.name.name
  if (name === 'dangerouslySetInnerHTML')
    throw mistake(name, filename, `write innerHTML={${reactHtmlSource(attr.value, code) ?? '...'}}`)
  if (name === 'classList')
    throw mistake(name, filename, 'pass one string to class, joining the names yourself')
  if (name === 'ref')
    return checkRef(attr.value, filename)
  checkSpelling(name, attr.value, filename)
  if (LOWERCASE_EVENT.test(name) && EVENT_PROPS.has(name.slice(2)))
    throw mistake(name, filename, `write ${eventProp(name.slice(2))}={...}, kay binds camelCase event props only`)
  if (!EVENT_ATTR.test(name))
    return
  checkHandler(name, attr.value, filename, code)
  if (!isCustomElement)
    checkEventName(name, filename)
}

function checkEventName(name: string, filename: string): void {
  const event = name.slice(2).toLowerCase()
  if (EVENT_PROPS.has(event))
    return
  const renamed = RENAMED_EVENTS.get(event)
  if (renamed !== undefined)
    throw mistake(name, filename, `write ${eventProp(renamed)}={...}`)
  if (event.endsWith(CAPTURE_SUFFIX) && EVENT_PROPS.has(event.slice(0, -CAPTURE_SUFFIX.length)))
    throw mistake(name, filename, `kay has no capture props, call addEventListener('${event.slice(0, -CAPTURE_SUFFIX.length)}', fn, { capture: true }) in a ref`)
  throw mistake(name, filename, `no DOM event is named "${event}"; for a custom event, call addEventListener in a ref`)
}

// Plain containers that never take focus unless given a tabIndex, so their onFocus/onBlur never fire.
const UNFOCUSABLE_TAGS = new Set([
  'article', 'aside', 'div', 'fieldset', 'footer', 'form', 'header', 'label', 'li', 'main', 'nav', 'ol', 'p', 'section',
  'span', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
])
const FOCUS_EVENTS = new Map([['onFocus', 'onFocusIn'], ['onBlur', 'onFocusOut']])
// Input types whose change event waits for the field to lose focus.
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

function staticAttr(attributes: readonly JSXAttributeItem[], name: string): JSXAttribute | undefined {
  for (const a of attributes) {
    if (a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === name)
      return a
  }
  return undefined
}

function checkFocusAndChange(tag: string, attributes: readonly JSXAttributeItem[], filename: string, warnings: string[]): void {
  const canFocus = !UNFOCUSABLE_TAGS.has(tag) || attributes.some(a =>
    a.type === 'JSXSpreadAttribute'
    || (a.name.type === 'JSXIdentifier' && ['tabIndex', 'tabindex', 'contentEditable', 'contenteditable'].includes(a.name.name)),
  )
  for (const [prop, bubbling] of FOCUS_EVENTS) {
    if (!canFocus && staticAttr(attributes, prop) !== undefined)
      throw mistake(`${prop} on <${tag}>`, filename, `focus does not bubble, write ${bubbling}={...}, or give the <${tag}> a tabIndex`)
  }
  if (staticAttr(attributes, 'onChange') === undefined)
    return
  const type = staticAttr(attributes, 'type')?.value
  const isTextField = tag === 'textarea' || (tag === 'input' && (type === undefined || (type?.type === 'Literal' && typeof type.value === 'string' && TEXT_INPUT_TYPES.has(type.value))))
  if (isTextField)
    warnings.push(`kay compiler: onChange on <${tag}> in ${filename} fires when the field loses focus, not per keystroke; write onInput={...} for every keystroke.`)
}

/** Throws when a JSX element would compile into something other than what its author meant, and adds to `warnings` what may be meant but usually is not. */
export function checkMistakes(element: JSXElement, filename: string, code: string, warnings: string[]): void {
  const tag = jsxTagName(element.openingElement.name)
  const isElement = tag !== '' && !isComponentTag(tag)
  const isCustomElement = tag.includes('-')
  if (tag === 'Suspense') {
    const children = filterMeaningfulChildren(element.children).length
    if (children > 1)
      throw mistake(`<Suspense> with ${children} children`, filename, 'give it one child, and one <Suspense> per async component')
  }
  const attributes = element.openingElement.attributes
  if (isElement && staticAttr(attributes, 'class') !== undefined && staticAttr(attributes, 'className') !== undefined)
    throw mistake('class and className', filename, 'keep one, they set the same attribute')
  if (isElement)
    checkFocusAndChange(tag, attributes, filename, warnings)
  for (const attr of attributes) {
    if (attr.type !== 'JSXAttribute')
      continue
    if (attr.name.type === 'JSXNamespacedName')
      checkNamespacedAttribute(attr.name.namespace.name, attr.name.name.name, filename)
    else if (isElement && attr.name.name === 'innerHTML')
      checkInnerHtml(element, tag, attr, filename, code)
    else if (isElement)
      checkElementAttribute(attr, isCustomElement, filename, code)
  }
}

function calleeName(callee: Node): string {
  if (callee.type === 'Identifier')
    return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier')
    return `${callee.object.name}.${callee.property.name}`
  return ''
}

// Each name a scope binds, true when it holds a signal() or computed().
type Scope = Map<string, boolean>

function bindPattern(scope: Scope, pattern: Node | null | undefined, isSignal = false): void {
  if (pattern === null || pattern === undefined)
    return
  if (pattern.type === 'Identifier') {
    scope.set(pattern.name, isSignal)
    return
  }
  walk(pattern, (node) => {
    if (node.type === 'Identifier')
      scope.set(node.name, false)
    // A default value or a computed key reads names, it binds none.
    if (node.type === 'AssignmentPattern')
      bindPattern(scope, node.left)
    else if (node.type === 'Property')
      bindPattern(scope, node.value)
    return node.type !== 'AssignmentPattern' && node.type !== 'Property'
  })
}

function bindStatements(scope: Scope, statements: readonly Node[], signalCallees: ReadonlySet<string>): void {
  for (const stmt of statements) {
    const decl = (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') ? stmt.declaration : stmt
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations)
        bindPattern(scope, d.id, d.init?.type === 'CallExpression' && signalCallees.has(calleeName(d.init.callee)))
    }
    else if ((decl?.type === 'FunctionDeclaration' || decl?.type === 'ClassDeclaration') && decl.id !== null) {
      scope.set(decl.id.name, false)
    }
    else if (decl?.type === 'ImportDeclaration') {
      for (const spec of decl.specifiers)
        scope.set(spec.local.name, false)
    }
  }
}

// The names a node opens a scope for, or undefined when it opens none.
function scopeOf(node: Node, signalCallees: ReadonlySet<string>): Scope | undefined {
  const scope: Scope = new Map()
  switch (node.type) {
    case 'Program':
    case 'BlockStatement':
    case 'StaticBlock':
      bindStatements(scope, node.body, signalCallees)
      return scope
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      if (node.type === 'FunctionExpression' && node.id !== null)
        scope.set(node.id.name, false)
      for (const param of node.params)
        bindPattern(scope, param)
      return scope
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      const head = node.type === 'ForStatement' ? node.init : node.left
      if (head?.type === 'VariableDeclaration')
        bindStatements(scope, [head], signalCallees)
      return scope
    }
    case 'CatchClause':
      bindPattern(scope, node.param)
      return scope
    case 'SwitchStatement':
      for (const c of node.cases)
        bindStatements(scope, c.consequent, signalCallees)
      return scope
    default:
      return undefined
  }
}

// Visits every JSX element or fragment of the program with the signals in scope there.
function walkWithSignals(program: Program, signalCallees: ReadonlySet<string>, visit: (node: Node, isSignal: (name: string) => boolean) => void): void {
  const scopes: Scope[] = []
  const isSignal = (name: string): boolean => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const found = scopes[i]!.get(name)
      if (found !== undefined)
        return found
    }
    return false
  }
  const visitor = (node: Node): boolean | void => {
    if (node.type === 'JSXElement' || node.type === 'JSXFragment')
      visit(node, isSignal)
    const scope = scopeOf(node, signalCallees)
    if (scope === undefined)
      return
    scopes.push(scope)
    for (const key of visitorKeys[node.type] ?? [])
      walk((node as unknown as Record<string, unknown>)[key], visitor)
    scopes.pop()
    return false
  }
  walk(program, visitor)
}

// The signal an expression reads without `.value` where JSX would print or test it.
function bareSignal(expr: Node, signals: (name: string) => boolean): string | undefined {
  const node = unwrapParens(expr)
  if (node.type === 'Identifier')
    return signals(node.name) ? node.name : undefined
  if (node.type === 'LogicalExpression' || node.type === 'BinaryExpression')
    return bareSignal(node.left, signals) ?? bareSignal(node.right, signals)
  if (node.type === 'ConditionalExpression')
    return bareSignal(node.test, signals)
  if (node.type === 'UnaryExpression')
    return bareSignal(node.argument, signals)
  if (node.type === 'TemplateLiteral') {
    for (const part of node.expressions) {
      const found = bareSignal(part, signals)
      if (found !== undefined)
        return found
    }
  }
  return undefined
}

/** Throws when JSX prints or tests a local signal or computed without `.value`, on an element's children or attributes. */
export function checkBareSignals(program: Program, signalCallees: ReadonlySet<string>, filename: string): void {
  if (signalCallees.size === 0)
    return
  walkWithSignals(program, signalCallees, (node, signals) => {
    if (node.type !== 'JSXElement' && node.type !== 'JSXFragment')
      return
    const refuse = (expr: Node): void => {
      const name = bareSignal(expr, signals)
      if (name !== undefined)
        throw mistake(`${name} without .value`, filename, `write ${name}.value`)
    }
    const tag = node.type === 'JSXElement' ? jsxTagName(node.openingElement.name) : ''
    if (isComponentTag(tag))
      return
    for (const child of node.children) {
      if (child.type === 'JSXExpressionContainer' && child.expression.type !== 'JSXEmptyExpression')
        refuse(child.expression)
    }
    if (node.type !== 'JSXElement')
      return
    for (const attr of node.openingElement.attributes) {
      if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier')
        continue
      const name = attr.name.name
      if (name !== '' && name !== 'ref' && name !== 'key' && !EVENT_ATTR.test(name) && attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression')
        refuse(attr.value.expression)
    }
  })
}

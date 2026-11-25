// Refuses JSX that compiles but does the wrong thing, mostly habits from React, Solid and Astro, with an error naming the fix.

import type { AstNode } from './analyze'
import { walk } from './analyze'
import { cleanJsxText, isComponentTag, jsxTagName, unwrapParens, VOID_ELEMENTS } from './shared'

// The kay prop for each DOM event, keyed by the event name kay binds (`onKeyDown` binds `keydown`).
const EVENT_PROPS = new Map(Object.entries({
  abort: 'onAbort', animationend: 'onAnimationEnd', animationiteration: 'onAnimationIteration', animationstart: 'onAnimationStart',
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
const EVENT_ATTR = /^on[A-Z]/

function eventProp(event: string): string {
  return EVENT_PROPS.get(event) ?? `on${event.charAt(0).toUpperCase()}${event.slice(1)}`
}

export function mistake(what: string, filename: string, fix: string): Error {
  return new Error(`kay compiler: ${what} in ${filename}: ${fix}.`)
}

const HYDRATE_MODES = new Set(['load', 'visible', 'idle', 'interaction', 'client'])
const MEDIA_MODE = /^media\(.+\)$/

/** Throws on a hydrate mode the browser runtime would silently treat as `load`; `*` stands for a mode picked at runtime. */
export function checkHydrateMode(mode: string, what: string, filename: string): void {
  if (mode !== '*' && !HYDRATE_MODES.has(mode) && !MEDIA_MODE.test(mode))
    throw mistake(what, filename, 'use load, visible, idle, interaction, client or media(<query>)')
}

function checkHandler(name: string, value: AstNode | null, filename: string, code: string): void {
  if (value?.type === 'Literal')
    throw mistake(`${name}="..."`, filename, `pass a function, ${name}={() => ...}`)
  if (value?.type !== 'JSXExpressionContainer')
    return
  const expr = value.expression as AstNode
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

function checkRef(value: AstNode | null, filename: string): void {
  if (value?.type === 'Literal')
    throw mistake('ref="..."', filename, 'pass a function, ref={el => ...}')
  if (value?.type === 'JSXExpressionContainer' && unwrapParens(value.expression as AstNode).type === 'ObjectExpression')
    throw mistake('ref={{ ... }}', filename, 'pass a function, ref={el => ...}, kay has no ref objects')
}

function checkSpelling(name: string, value: AstNode | null, filename: string): void {
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
function reactHtmlSource(value: AstNode | null, code: string): string | undefined {
  if (value?.type !== 'JSXExpressionContainer')
    return undefined
  const expr = unwrapParens(value.expression as AstNode)
  if (expr.type !== 'ObjectExpression')
    return undefined
  const html = (expr.properties as AstNode[]).find(p => p.type === 'Property' && (p.key?.name ?? p.key?.value) === '__html')
  return html === undefined ? undefined : code.slice(html.value.start, html.value.end)
}

function countChildren(element: AstNode): number {
  return (element.children as AstNode[]).filter(child =>
    child.type === 'JSXText' ? cleanJsxText(child.value as string) !== '' : !(child.type === 'JSXExpressionContainer' && child.expression.type === 'JSXEmptyExpression')).length
}

function checkInnerHtml(element: AstNode, tag: string, attr: AstNode, filename: string, code: string): void {
  const html = reactHtmlSource(attr.value, code)
  if (html !== undefined)
    throw mistake('innerHTML={{ __html }}', filename, `write innerHTML={${html}}, kay takes the HTML string itself`)
  if (VOID_ELEMENTS.has(tag))
    throw mistake(`innerHTML on <${tag}>`, filename, 'a void element has no content, drop innerHTML')
  if (countChildren(element) > 0)
    throw mistake('innerHTML with children', filename, 'keep one, the children or innerHTML')
}

function checkElementAttribute(attr: AstNode, isCustomElement: boolean, filename: string, code: string): void {
  const name = attr.name.name as string
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

/** Throws when a JSX element would compile into something other than what its author meant. */
export function checkMistakes(element: AstNode, filename: string, code: string): void {
  const tag = jsxTagName(element.openingElement.name)
  const isElement = tag !== '' && !isComponentTag(tag)
  const isCustomElement = tag.includes('-')
  if (tag === 'Suspense') {
    const children = countChildren(element)
    if (children > 1)
      throw mistake(`<Suspense> with ${children} children`, filename, 'give it one child, and one <Suspense> per async component')
  }
  const attributes = element.openingElement.attributes as AstNode[]
  if (isElement && attributes.some(a => a.name?.name === 'class') && attributes.some(a => a.name?.name === 'className'))
    throw mistake('class and className', filename, 'keep one, they set the same attribute')
  for (const attr of attributes) {
    if (attr.type !== 'JSXAttribute')
      continue
    if (attr.name.type === 'JSXNamespacedName')
      checkNamespacedAttribute(attr.name.namespace.name as string, attr.name.name.name as string, filename)
    else if (isElement && attr.name.name === 'innerHTML')
      checkInnerHtml(element, tag, attr, filename, code)
    else if (isElement)
      checkElementAttribute(attr, isCustomElement, filename, code)
  }
}

function calleeName(callee: AstNode): string {
  if (callee.type === 'Identifier')
    return callee.name as string
  if (callee.type === 'MemberExpression' && callee.object?.type === 'Identifier')
    return `${callee.object.name as string}.${callee.property?.name as string}`
  return ''
}

// Names bound once in the file to a signal() or computed() call; a name bound twice may be shadowed, so it is left out.
function signalNames(program: AstNode, signalCallees: ReadonlySet<string>): Set<string> {
  const bindings = new Map<string, number>()
  const signals = new Set<string>()
  const bind = (id: AstNode | null | undefined): void => {
    if (id?.type === 'Identifier')
      bindings.set(id.name as string, (bindings.get(id.name as string) ?? 0) + 1)
  }
  walk(program, (node) => {
    if (node.type === 'VariableDeclarator') {
      bind(node.id)
      if (node.id?.type === 'Identifier' && node.init?.type === 'CallExpression' && signalCallees.has(calleeName(node.init.callee as AstNode)))
        signals.add(node.id.name as string)
    }
    else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      bind(node.id)
      for (const param of node.params as AstNode[])
        walk(param, (p) => { if (p.type === 'Identifier') bind(p) })
    }
  })
  for (const name of signals) {
    if (bindings.get(name) !== 1)
      signals.delete(name)
  }
  return signals
}

// The signal an expression reads without `.value` where JSX would print or test it.
function bareSignal(expr: AstNode, signals: ReadonlySet<string>): string | undefined {
  const node = unwrapParens(expr)
  if (node.type === 'Identifier')
    return signals.has(node.name as string) ? node.name as string : undefined
  if (node.type === 'LogicalExpression' || node.type === 'BinaryExpression')
    return bareSignal(node.left as AstNode, signals) ?? bareSignal(node.right as AstNode, signals)
  if (node.type === 'ConditionalExpression')
    return bareSignal(node.test as AstNode, signals)
  if (node.type === 'UnaryExpression')
    return bareSignal(node.argument as AstNode, signals)
  if (node.type === 'TemplateLiteral') {
    for (const part of node.expressions as AstNode[]) {
      const found = bareSignal(part, signals)
      if (found !== undefined)
        return found
    }
  }
  return undefined
}

/** Throws when JSX prints or tests a local signal or computed without `.value`, on an element's children or attributes. */
export function checkBareSignals(program: AstNode, signalCallees: ReadonlySet<string>, filename: string): void {
  if (signalCallees.size === 0)
    return
  const signals = signalNames(program, signalCallees)
  if (signals.size === 0)
    return
  const refuse = (expr: AstNode): void => {
    const name = bareSignal(expr, signals)
    if (name !== undefined)
      throw mistake(`${name} without .value`, filename, `write ${name}.value`)
  }
  walk(program, (node) => {
    if (node.type !== 'JSXElement' && node.type !== 'JSXFragment')
      return
    const tag = node.type === 'JSXElement' ? jsxTagName(node.openingElement.name) : ''
    if (isComponentTag(tag))
      return
    for (const child of node.children as AstNode[]) {
      if (child.type === 'JSXExpressionContainer' && child.expression.type !== 'JSXEmptyExpression')
        refuse(child.expression as AstNode)
    }
    if (node.type !== 'JSXElement')
      return
    for (const attr of node.openingElement.attributes as AstNode[]) {
      const name = attr.type === 'JSXAttribute' && attr.name.type === 'JSXIdentifier' ? attr.name.name as string : ''
      if (name !== '' && name !== 'ref' && name !== 'key' && !EVENT_ATTR.test(name) && attr.value?.type === 'JSXExpressionContainer')
        refuse(attr.value.expression as AstNode)
    }
  })
}

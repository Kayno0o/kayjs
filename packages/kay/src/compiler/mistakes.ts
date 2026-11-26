// Refuses JSX that compiles but does the wrong thing, mostly habits from React, Solid and Astro, with an error naming the fix.

import type { JSXAttribute, JSXAttributeItem, JSXElement, Node } from 'oxc-parser'
import type { ComplianceRule } from './compliance'
import type { ServerOnlyInIsland } from './interactivity'
import { URL_ATTRS } from '../attrs'
import { walk } from './ast'
import { calleeName, EVENT_ATTR, filterMeaningfulChildren, isComponentTag, isUnsafeUrlAttr, jsxTagName, unwrapParens, unwrapTsExpr, VOID_ELEMENTS } from './shared'

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

/** A compiler mistake, with the source offset of the code it names once known. */
export class KayMistake extends Error {
  start: number | undefined = undefined
}

/** Code that compiles but usually means something else, at its source offset. */
export interface CompilerWarning {
  message: string
  start: number
  rule?: ComplianceRule | undefined
  urlOrigin?: string | undefined
}

export function mistake(what: string, filename: string, fix: string): KayMistake {
  return new KayMistake(`kay compiler: ${what} in ${filename}: ${fix}.`)
}

let collected: KayMistake[] | undefined

/** Runs one check, a mistake it throws placed at `start`. The build stops at the first mistake; while `collectMistakes` runs, the mistake is recorded and the caller goes on. */
export function guarded(start: number, check: () => void): void {
  try {
    check()
  }
  catch (err) {
    if (!(err instanceof KayMistake))
      throw err
    err.start ??= start
    if (collected === undefined)
      throw err
    collected.push(err)
  }
}

/** Runs `fn` with every guarded check recording its mistake; `error` is what `fn` threw past them, a syntax error or a mistake that stops the analysis. */
export function collectMistakes<T>(fn: () => T): { value: T | undefined, mistakes: KayMistake[], error: unknown } {
  const prev = collected
  const mistakes: KayMistake[] = []
  collected = mistakes
  try {
    return { value: fn(), mistakes, error: undefined }
  }
  catch (error) {
    return { value: undefined, mistakes, error }
  }
  finally {
    collected = prev
  }
}

export function islandRemoved(filename: string, start?: number): KayMistake {
  const err = mistake('island()', filename, 'it is gone; write export const hydrate = \'visible\' in the component\'s file, or set $hydrate where it renders')
  err.start = start
  return err
}

// `<Head>` and `<Suspense>` run during server rendering only, so in an island they never update.
export function serverOnlyTagError(filename: string, { tag, island, reason, offset }: ServerOnlyInIsland): KayMistake {
  const err = mistake(`<${tag}> in an island`, filename, `${island} is an island because it ${reason}; move <${tag}> to the page or a layout, outside any component with state or handlers`)
  err.start = offset
  return err
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

/** Extracts a static string literal or zero-interpolation template literal after unwrapping TS assertions. */
export function staticStringValue(node: Node | null | undefined): string | undefined {
  if (node === null || node === undefined)
    return undefined
  const val = unwrapTsExpr(node)
  if (val.type === 'Literal' && typeof val.value === 'string')
    return val.value
  return val.type === 'TemplateLiteral' && val.expressions.length === 0 ? (val.quasis[0]?.value.cooked ?? undefined) : undefined
}

/** Validates an `export const hydrate = ...` initializer and returns its string mode when statically known. */
export function checkExportHydrate(init: Node | null | undefined, filename: string): string | undefined {
  if (init === null || init === undefined)
    return undefined
  const mode = staticStringValue(init)
  if (mode !== undefined) {
    guarded(init.start, () => checkHydrateMode(mode, `hydrate = "${mode}"`, filename))
    return mode
  }
  const val = unwrapTsExpr(init)
  if (val.type === 'Literal' || val.type === 'ArrayExpression' || val.type === 'ObjectExpression' || (val.type === 'Identifier' && val.name === 'undefined'))
    guarded(init.start, () => { throw mistake('hydrate', filename, 'use load, visible, idle, interaction, client or media(<query>)') })
  return undefined
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

const CAMEL_ARIA = /^aria[A-Z]/

function checkSpelling(name: string, value: JSXAttribute['value'], filename: string): void {
  if (CAMEL_ARIA.test(name))
    throw mistake(name, filename, `write aria-${name.slice(4).toLowerCase()}={...}, ARIA attributes use kebab-case`)
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

function staticStringAttr(value: JSXAttribute['value']): string | undefined {
  if (value === null)
    return undefined
  if (value.type === 'Literal' && typeof value.value === 'string')
    return value.value
  if (value.type === 'JSXExpressionContainer' && value.expression.type !== 'JSXEmptyExpression') {
    const expr = unwrapParens(value.expression)
    if (expr.type === 'Literal' && typeof expr.value === 'string')
      return expr.value
    if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0)
      return expr.quasis[0]?.value.cooked ?? undefined
  }
  return undefined
}

function checkElementAttribute(attr: JSXAttribute, tag: string, isCustomElement: boolean, filename: string, code: string, warnings: CompilerWarning[]): void {
  if (attr.name.type !== 'JSXIdentifier')
    return
  const name = attr.name.name
  if (name === '$hydrate')
    throw mistake(`$hydrate on <${tag}>`, filename, 'only components can be islands; drop $hydrate, or move it onto a component tag')
  if (name.toLowerCase() === 'srcdoc')
    throw mistake(`${name} on <${tag}>`, filename, 'kay blocks srcdoc for XSS safety; serve the document from a route and load it with src')
  if (name === 'dangerouslySetInnerHTML')
    throw mistake(name, filename, `write innerHTML={${reactHtmlSource(attr.value, code) ?? '...'}}`)
  if (name === 'classList')
    throw mistake(name, filename, 'pass one string to class, joining the names yourself')
  if (name === 'ref')
    return checkRef(attr.value, filename)
  checkSpelling(name, attr.value, filename)
  if (URL_ATTRS.has(name.toLowerCase())) {
    const urlText = staticStringAttr(attr.value)
    if (urlText !== undefined && isUnsafeUrlAttr(name, urlText, tag))
      warnings.push({ message: `kay compiler: unsafe URL in ${name} on <${tag}> in ${filename}; kay strips javascript:, vbscript:, and non-image data: URLs.`, start: attr.start })
  }
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

function checkFocusAndChange(tag: string, attributes: readonly JSXAttributeItem[], filename: string, warnings: CompilerWarning[]): void {
  const canFocus = !UNFOCUSABLE_TAGS.has(tag) || attributes.some(a =>
    a.type === 'JSXSpreadAttribute'
    || (a.name.type === 'JSXIdentifier' && ['tabIndex', 'tabindex', 'contentEditable', 'contenteditable'].includes(a.name.name)),
  )
  for (const [prop, bubbling] of FOCUS_EVENTS) {
    const attr = canFocus ? undefined : staticAttr(attributes, prop)
    if (attr !== undefined)
      guarded(attr.start, () => { throw mistake(`${prop} on <${tag}>`, filename, `focus does not bubble, write ${bubbling}={...}, or give the <${tag}> a tabIndex`) })
  }
  const onChange = staticAttr(attributes, 'onChange')
  if (onChange === undefined)
    return
  const type = staticAttr(attributes, 'type')?.value
  const isTextField = tag === 'textarea' || (tag === 'input' && (type === undefined || (type?.type === 'Literal' && typeof type.value === 'string' && TEXT_INPUT_TYPES.has(type.value))))
  if (isTextField)
    warnings.push({ message: `kay compiler: onChange on <${tag}> in ${filename} fires when the field loses focus, not per keystroke; write onInput={...} for every keystroke.`, start: onChange.start })
}

/** Throws when a JSX element would compile into something other than what its author meant, and adds to `warnings` what may be meant but usually is not. */
export function checkMistakes(
  element: JSXElement,
  filename: string,
  code: string,
  warnings: CompilerWarning[],
  resolveTag: (tag: string) => string | undefined = t => (t === 'Suspense' || t === 'Region' ? t : undefined),
): void {
  const tag = jsxTagName(element.openingElement.name)
  const canonical = resolveTag(tag)
  const isElement = tag !== '' && !isComponentTag(tag)
  const isCustomElement = tag.includes('-')
  if (canonical === 'Suspense') {
    const children = filterMeaningfulChildren(element.children).length
    if (children > 1)
      guarded(element.start, () => { throw mistake(`<Suspense> with ${children} children`, filename, 'give it one child, and one <Suspense> per async component') })
  }
  const attributes = element.openingElement.attributes
  guarded(element.start, () => checkRegionMarkup(tag, canonical, isElement, attributes, filename, element, resolveTag))
  if (isElement)
    guarded(element.start, () => checkKeepScroll(element, attributes, filename))
  if (isElement && VOID_ELEMENTS.has(tag) && (filterMeaningfulChildren(element.children).length > 0 || staticAttr(attributes, 'children') !== undefined))
    guarded(element.start, () => { throw mistake(`<${tag}> with children`, filename, `a void element has no content; write <${tag} />`) })
  const className = isElement && staticAttr(attributes, 'class') !== undefined ? staticAttr(attributes, 'className') : undefined
  if (className !== undefined)
    guarded(className.start, () => { throw mistake('class and className', filename, 'keep one, they set the same attribute') })
  const htmlFor = isElement && staticAttr(attributes, 'for') !== undefined ? staticAttr(attributes, 'htmlFor') : undefined
  if (htmlFor !== undefined)
    guarded(htmlFor.start, () => { throw mistake('for and htmlFor', filename, 'keep one, they set the same attribute') })
  if (isElement)
    checkFocusAndChange(tag, attributes, filename, warnings)
  for (const attr of attributes) {
    if (attr.type !== 'JSXAttribute')
      continue
    guarded(attr.start, () => {
      if (attr.name.type === 'JSXNamespacedName')
        checkNamespacedAttribute(attr.name.namespace.name, attr.name.name.name, filename)
      else if (isElement && attr.name.name === 'innerHTML')
        checkInnerHtml(element, tag, attr, filename, code)
      else if (isElement)
        checkElementAttribute(attr, tag, isCustomElement, filename, code, warnings)
    })
  }
}

// A literal string value of an attribute, when it has one.
function literalText(attr: JSXAttribute): string | undefined {
  return attr.value?.type === 'Literal' && typeof attr.value.value === 'string' ? attr.value.value : undefined
}

// A region may hold others, each under its own name: the page tells a region from the one around it by name.
function checkRegionNesting(
  element: JSXElement,
  attributes: readonly JSXAttributeItem[],
  filename: string,
  resolveTag: (tag: string) => string | undefined,
): void {
  const outer = staticAttr(attributes, 'name')
  const name = outer === undefined ? undefined : literalText(outer)
  if (name === undefined)
    return
  walk(element.children, (node) => {
    if (node.type !== 'JSXElement' || resolveTag(jsxTagName(node.openingElement.name)) !== 'Region')
      return
    const inner = staticAttr(node.openingElement.attributes, 'name')
    if (inner !== undefined && literalText(inner) === name)
      throw mistake(`<Region name="${name}"> inside <Region name="${name}">`, filename, 'give the inner one its own name')
  })
}

// The markup `regions()` from `@kayjs/spa` reads: <Region name>, and data-kay-target, data-kay-append and data-kay-live on the elements that can use them.
function checkRegionMarkup(
  tag: string,
  canonical: string | undefined,
  isElement: boolean,
  attributes: readonly JSXAttributeItem[],
  filename: string,
  element: JSXElement,
  resolveTag: (tag: string) => string | undefined,
): void {
  if (canonical === 'Region')
    checkRegionNesting(element, attributes, filename, resolveTag)
  if (canonical === 'Region' && staticAttr(attributes, 'name') === undefined && !attributes.some(a => a.type === 'JSXSpreadAttribute'))
    throw mistake('<Region> without a name', filename, 'write <Region name="pane">, the name a link names in data-kay-target')
  if (!isElement)
    return
  const target = staticAttr(attributes, 'data-kay-target')
  if (target !== undefined && tag !== 'a' && tag !== 'form')
    throw mistake(`data-kay-target on <${tag}>`, filename, 'put it on the <a href> or the <form> that should swap the region')
  const method = tag === 'form' && target !== undefined ? staticAttr(attributes, 'method') : undefined
  const methodText = method === undefined ? undefined : literalText(method)
  if (methodText !== undefined && methodText.toLowerCase() !== 'get' && staticAttr(attributes, 'data-kay-live') !== undefined)
    throw mistake(`data-kay-live on a <form method="${methodText}">`, filename, 'a form that swaps while typing is a GET: use method="get", or drop data-kay-live')
  if (target === undefined && staticAttr(attributes, 'data-kay-append') !== undefined)
    throw mistake('data-kay-append without data-kay-target', filename, 'name the region the next page is appended to: data-kay-target="results"')
  if (staticAttr(attributes, 'data-kay-live') !== undefined && (tag !== 'form' || target === undefined))
    throw mistake('data-kay-live', filename, 'it belongs on a <form method="get" data-kay-target="..."> that swaps while typing')
}

// data-kay-keep-scroll names a panel for the script keeping its scroll offset across page loads, so its key is a literal the page can be read for, and an element inside the panel cannot take the same key.
function checkKeepScroll(element: JSXElement, attributes: readonly JSXAttributeItem[], filename: string): void {
  const attr = staticAttr(attributes, 'data-kay-keep-scroll')
  if (attr === undefined)
    return
  const keyOf = (a: JSXAttribute) => a.value?.type === 'JSXExpressionContainer' ? staticStringValue(a.value.expression as Node) : literalText(a)
  const key = keyOf(attr)
  if (key === undefined || key.trim() === '' || /["<>&]/.test(key))
    throw mistake('data-kay-keep-scroll without a literal key', filename, 'write data-kay-keep-scroll="side": a plain string naming the panel, with no quote, < > or &')
  walk(element.children, (node) => {
    if (node.type !== 'JSXElement')
      return
    const inner = staticAttr(node.openingElement.attributes, 'data-kay-keep-scroll')
    if (inner !== undefined && keyOf(inner) === key)
      throw mistake(`data-kay-keep-scroll="${key}" inside data-kay-keep-scroll="${key}"`, filename, 'give each panel its own key')
  })
}

const DIRECTIVE_FIXES: Record<string, string> = {
  'use client': 'delete it, kay makes a component an island by itself when it uses state or handlers',
  'use server': 'delete it, a server function is an action() exported from its own file',
}

/** Throws on a React or Next habit plain code carries: a 'use client' or 'use server' directive, or an effect(async ...). */
export function checkHabits(node: Node, isEffect: (callee: string) => boolean, filename: string): void {
  if (node.type === 'ExpressionStatement' && 'directive' in node && typeof node.directive === 'string') {
    const fix = DIRECTIVE_FIXES[node.directive]
    if (fix !== undefined)
      guarded(node.start, () => { throw mistake(`'${node.directive}'`, filename, fix) })
    return
  }
  if (node.type !== 'CallExpression' || !isEffect(calleeName(node.callee)))
    return
  const fn = node.arguments[0]
  if ((fn?.type === 'ArrowFunctionExpression' || fn?.type === 'FunctionExpression') && fn.async)
    guarded(fn.start, () => { throw mistake('effect(async ...)', filename, 'effect tracks only what it reads before the first await and takes a cleanup function, not a Promise; start the async work inside a plain effect') })
}

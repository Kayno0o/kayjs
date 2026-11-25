// Refuses JSX that compiles but does the wrong thing, mostly habits from React, Solid and Astro, with an error naming the fix.

import type { AstNode } from './analyze'
import { isComponentTag, jsxTagName } from './shared'

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

function mistake(what: string, filename: string, fix: string): Error {
  return new Error(`kay compiler: ${what} in ${filename}: ${fix}.`)
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

function checkElementAttribute(attr: AstNode, isCustomElement: boolean, filename: string, code: string): void {
  const name = attr.name.name as string
  if (name === 'dangerouslySetInnerHTML') {
    const expr = attr.value?.type === 'JSXExpressionContainer' ? attr.value.expression as AstNode : undefined
    const html = expr?.type === 'ObjectExpression'
      ? (expr.properties as AstNode[]).find(p => p.type === 'Property' && (p.key?.name ?? p.key?.value) === '__html')
      : undefined
    throw mistake(name, filename, `write innerHTML={${html === undefined ? '...' : code.slice(html.value.start, html.value.end)}}`)
  }
  if (name === 'classList')
    throw mistake(name, filename, 'pass one string to class, joining the names yourself')
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

/** Throws when a JSX opening element would compile into something other than what its author meant. */
export function checkMistakes(node: AstNode, filename: string, code: string): void {
  if (node.type !== 'JSXOpeningElement')
    return
  const tag = jsxTagName(node.name)
  const isElement = tag !== '' && !isComponentTag(tag)
  const isCustomElement = tag.includes('-')
  for (const attr of node.attributes as AstNode[]) {
    if (attr.type !== 'JSXAttribute')
      continue
    if (attr.name.type === 'JSXNamespacedName')
      checkNamespacedAttribute(attr.name.namespace.name as string, attr.name.name.name as string, filename)
    else if (isElement)
      checkElementAttribute(attr, isCustomElement, filename, code)
  }
}

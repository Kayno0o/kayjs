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
}))

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

function checkElementAttribute(attr: AstNode, filename: string, code: string): void {
  if (attr.name.type === 'JSXNamespacedName') {
    const namespace = attr.name.namespace.name as string
    const name = attr.name.name.name as string
    if (namespace === 'on')
      throw mistake(`on:${name}`, filename, `write ${eventProp(name.toLowerCase())}={...}`)
    return
  }
  const name = attr.name.name as string
  if (LOWERCASE_EVENT.test(name) && EVENT_PROPS.has(name.slice(2)))
    throw mistake(name, filename, `write ${eventProp(name.slice(2))}={...}, kay binds camelCase event props only`)
  if (EVENT_ATTR.test(name))
    checkHandler(name, attr.value, filename, code)
}

/** Throws when a JSX opening element would compile into something other than what its author meant. */
export function checkMistakes(node: AstNode, filename: string, code: string): void {
  if (node.type !== 'JSXOpeningElement')
    return
  const tag = jsxTagName(node.name)
  if (tag === '' || isComponentTag(tag))
    return
  for (const attr of node.attributes as AstNode[]) {
    if (attr.type === 'JSXAttribute')
      checkElementAttribute(attr, filename, code)
  }
}

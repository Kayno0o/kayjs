/// <reference path="./ambient.d.ts" />
// TypeScript JSX runtime types for Kay v2.
// Standard TSX compiles away at build time; these types derive HTML/SVG element attributes from lib.dom,
// type event `currentTarget` and `ref` per element, support async components, and allow custom elements via augmentation.

export type HydrateStrategy =
  | 'load'
  | 'visible'
  | 'idle'
  | 'interaction'
  | 'client'
  | `media(${string})`

export type KayChild =
  | string
  | number
  | boolean
  | null
  | undefined
  | Html
  | Node
  | KayChild[]

declare const htmlBrand: unique symbol

/** HTML kay injects unescaped; only `raw()` makes one, so a plain `{ __html }` object is not an Html. */
export interface Html {
  readonly __html: string
  readonly [htmlBrand]: true
}

export type Component<P = Record<string, unknown>> = (props: P) => KayChild | Promise<KayChild>

export function Fragment(props: { children?: KayChild }): KayChild {
  return props.children
}

// Runtime fallbacks (only used if JSX isn't compiled, e.g. quick tests)
export function jsx(tag: unknown, props: Record<string, unknown>): KayChild | Promise<KayChild> {
  if (typeof tag === 'function')
    return (tag as Component)(props)
  return null
}

export const jsxs = jsx
export const jsxDEV = jsx

export type TargetedEvent<T extends EventTarget = Element, E extends Event = Event> = Omit<E, 'currentTarget'> & {
  readonly currentTarget: T
}

export type EventHandler<T extends EventTarget, E extends Event = Event> = (e: TargetedEvent<T, E>) => void

export interface DOMEventHandlers<T extends EventTarget = Element> {
  // Mouse & pointer
  onClick?: EventHandler<T, MouseEvent> | undefined
  onDblClick?: EventHandler<T, MouseEvent> | undefined
  onAuxClick?: EventHandler<T, MouseEvent> | undefined
  onContextMenu?: EventHandler<T, MouseEvent> | undefined
  onMouseDown?: EventHandler<T, MouseEvent> | undefined
  onMouseUp?: EventHandler<T, MouseEvent> | undefined
  onMouseMove?: EventHandler<T, MouseEvent> | undefined
  onMouseEnter?: EventHandler<T, MouseEvent> | undefined
  onMouseLeave?: EventHandler<T, MouseEvent> | undefined
  onMouseOver?: EventHandler<T, MouseEvent> | undefined
  onMouseOut?: EventHandler<T, MouseEvent> | undefined
  onPointerDown?: EventHandler<T, PointerEvent> | undefined
  onPointerUp?: EventHandler<T, PointerEvent> | undefined
  onPointerMove?: EventHandler<T, PointerEvent> | undefined
  onPointerEnter?: EventHandler<T, PointerEvent> | undefined
  onPointerLeave?: EventHandler<T, PointerEvent> | undefined
  onPointerOver?: EventHandler<T, PointerEvent> | undefined
  onPointerOut?: EventHandler<T, PointerEvent> | undefined
  onPointerCancel?: EventHandler<T, PointerEvent> | undefined
  onGotPointerCapture?: EventHandler<T, PointerEvent> | undefined
  onLostPointerCapture?: EventHandler<T, PointerEvent> | undefined
  // Touch
  onTouchStart?: EventHandler<T, TouchEvent> | undefined
  onTouchMove?: EventHandler<T, TouchEvent> | undefined
  onTouchEnd?: EventHandler<T, TouchEvent> | undefined
  onTouchCancel?: EventHandler<T, TouchEvent> | undefined
  // Keyboard & composition
  onKeyDown?: EventHandler<T, KeyboardEvent> | undefined
  onKeyUp?: EventHandler<T, KeyboardEvent> | undefined
  onKeyPress?: EventHandler<T, KeyboardEvent> | undefined
  onCompositionStart?: EventHandler<T, CompositionEvent> | undefined
  onCompositionUpdate?: EventHandler<T, CompositionEvent> | undefined
  onCompositionEnd?: EventHandler<T, CompositionEvent> | undefined
  // Focus
  onFocus?: EventHandler<T, FocusEvent> | undefined
  onBlur?: EventHandler<T, FocusEvent> | undefined
  onFocusIn?: EventHandler<T, FocusEvent> | undefined
  onFocusOut?: EventHandler<T, FocusEvent> | undefined
  // Form & input
  onInput?: EventHandler<T, Event> | undefined
  onBeforeInput?: EventHandler<T, InputEvent> | undefined
  onChange?: EventHandler<T, Event> | undefined
  onSubmit?: EventHandler<T, SubmitEvent> | undefined
  onReset?: EventHandler<T, Event> | undefined
  onInvalid?: EventHandler<T, Event> | undefined
  onFormData?: EventHandler<T, FormDataEvent> | undefined
  onSelect?: EventHandler<T, Event> | undefined
  onSearch?: EventHandler<T, Event> | undefined
  // Scroll & wheel
  onScroll?: EventHandler<T, Event> | undefined
  onScrollEnd?: EventHandler<T, Event> | undefined
  onWheel?: EventHandler<T, WheelEvent> | undefined
  onResize?: EventHandler<T, UIEvent> | undefined
  // Drag & drop
  onDrag?: EventHandler<T, DragEvent> | undefined
  onDragStart?: EventHandler<T, DragEvent> | undefined
  onDragEnd?: EventHandler<T, DragEvent> | undefined
  onDragEnter?: EventHandler<T, DragEvent> | undefined
  onDragLeave?: EventHandler<T, DragEvent> | undefined
  onDragOver?: EventHandler<T, DragEvent> | undefined
  onDrop?: EventHandler<T, DragEvent> | undefined
  // Clipboard
  onCopy?: EventHandler<T, ClipboardEvent> | undefined
  onCut?: EventHandler<T, ClipboardEvent> | undefined
  onPaste?: EventHandler<T, ClipboardEvent> | undefined
  // Dialog, details & popover
  onToggle?: EventHandler<T, ToggleEvent> | undefined
  onBeforeToggle?: EventHandler<T, ToggleEvent> | undefined
  onClose?: EventHandler<T, Event> | undefined
  onCancel?: EventHandler<T, Event> | undefined
  // Media & resource lifecycle
  onLoad?: EventHandler<T, Event> | undefined
  onLoadStart?: EventHandler<T, Event> | undefined
  onLoadEnd?: EventHandler<T, ProgressEvent> | undefined
  onError?: EventHandler<T, Event> | undefined
  onAbort?: EventHandler<T, Event> | undefined
  onPlay?: EventHandler<T, Event> | undefined
  onPause?: EventHandler<T, Event> | undefined
  onPlaying?: EventHandler<T, Event> | undefined
  onEnded?: EventHandler<T, Event> | undefined
  onTimeUpdate?: EventHandler<T, Event> | undefined
  onLoadedMetadata?: EventHandler<T, Event> | undefined
  onLoadedData?: EventHandler<T, Event> | undefined
  onCanPlay?: EventHandler<T, Event> | undefined
  onCanPlayThrough?: EventHandler<T, Event> | undefined
  onDurationChange?: EventHandler<T, Event> | undefined
  onEmptied?: EventHandler<T, Event> | undefined
  onProgress?: EventHandler<T, ProgressEvent> | undefined
  onRateChange?: EventHandler<T, Event> | undefined
  onSeeked?: EventHandler<T, Event> | undefined
  onSeeking?: EventHandler<T, Event> | undefined
  onStalled?: EventHandler<T, Event> | undefined
  onSuspend?: EventHandler<T, Event> | undefined
  onVolumeChange?: EventHandler<T, Event> | undefined
  onWaiting?: EventHandler<T, Event> | undefined
  // CSS animations & transitions
  onAnimationStart?: EventHandler<T, AnimationEvent> | undefined
  onAnimationEnd?: EventHandler<T, AnimationEvent> | undefined
  onAnimationIteration?: EventHandler<T, AnimationEvent> | undefined
  onAnimationCancel?: EventHandler<T, AnimationEvent> | undefined
  onTransitionStart?: EventHandler<T, TransitionEvent> | undefined
  onTransitionEnd?: EventHandler<T, TransitionEvent> | undefined
  onTransitionRun?: EventHandler<T, TransitionEvent> | undefined
  onTransitionCancel?: EventHandler<T, TransitionEvent> | undefined
  // Misc
  onSlotChange?: EventHandler<T, Event> | undefined
  onSelectionChange?: EventHandler<T, Event> | undefined
  onSelectStart?: EventHandler<T, Event> | undefined
  onBeforeMatch?: EventHandler<T, Event> | undefined
}

export interface CommonAttributes<T extends Element = Element> extends DOMEventHandlers<T> {
  id?: string | undefined
  class?: string | undefined
  className?: string | undefined
  style?: string | Record<string, string | number | undefined> | undefined
  title?: string | undefined
  tabIndex?: number | string | undefined
  tabindex?: number | string | undefined
  hidden?: boolean | 'until-found' | undefined
  inert?: boolean | undefined
  role?: string | undefined
  lang?: string | undefined
  dir?: 'ltr' | 'rtl' | 'auto' | string | undefined
  draggable?: boolean | 'true' | 'false' | undefined
  contentEditable?: boolean | 'true' | 'false' | 'plaintext-only' | undefined
  contenteditable?: boolean | 'true' | 'false' | 'plaintext-only' | undefined
  spellCheck?: boolean | 'true' | 'false' | undefined
  spellcheck?: boolean | 'true' | 'false' | undefined
  translate?: 'yes' | 'no' | undefined
  accessKey?: string | undefined
  accesskey?: string | undefined
  autoCapitalize?: string | undefined
  autocapitalize?: string | undefined
  autoFocus?: boolean | undefined
  autofocus?: boolean | undefined
  enterKeyHint?: string | undefined
  enterkeyhint?: string | undefined
  inputMode?: string | undefined
  inputmode?: string | undefined
  is?: string | undefined
  itemProp?: string | undefined
  itemScope?: boolean | undefined
  itemType?: string | undefined
  nonce?: string | undefined
  part?: string | undefined
  popover?: '' | 'auto' | 'manual' | 'hint' | boolean | undefined
  slot?: string | undefined
  children?: KayChild | undefined
  key?: string | number | undefined
  ref?: ((el: T) => void) | undefined
  $hydrate?: HydrateStrategy | undefined
  innerHTML?: string | Html | null | undefined
  // Spellings from React and Solid that kay refuses at compile time, refused here first.
  dangerouslySetInnerHTML?: never
  classList?: never
  defaultValue?: never
  defaultChecked?: never
  onDoubleClick?: never
  [attr: `data-${string}`]: string | number | boolean | undefined
  [attr: `aria-${string}`]: string | number | boolean | undefined
}

type WritableKeys<T> = {
  [K in keyof T]-?: (<F>() => F extends { [Q in K]: T[K] } ? 1 : 2) extends (<F>() => F extends { -readonly [Q in K]: T[K] } ? 1 : 2)
    ? K
    : never
}[keyof T]

type BlockedDomProps =
  | keyof CommonAttributes
  | 'outerHTML'
  | 'innerText'
  | 'outerText'
  | 'textContent'
  | 'nodeValue'
  | 'scrollTop'
  | 'scrollLeft'
  | 'selectionStart'
  | 'selectionEnd'
  | 'selectionDirection'
  | 'valueAsNumber'
  | 'indeterminate'
  | 'prefix'
  | 'localName'
  | 'namespaceURI'

type PrimitiveDomPropKeys<E> = {
  [K in Exclude<WritableKeys<E>, BlockedDomProps | `on${string}`>]:
  NonNullable<E[K]> extends string | number | boolean ? K : never
}[Exclude<WritableKeys<E>, BlockedDomProps | `on${string}`>]

type DomAttrValue<V> =
  NonNullable<V> extends boolean
    ? boolean | undefined
    : NonNullable<V> extends number
      ? number | string | undefined
      : V | undefined

type DerivedDomAttributes<E> = {
  [K in PrimitiveDomPropKeys<E>]?: DomAttrValue<E[K]>
}

export type HTMLAttributes<E extends HTMLElement = HTMLElement> = CommonAttributes<E> & DerivedDomAttributes<E>

// Element-specific HTML attribute extras (lowercase spellings, form actions, popover triggers, etc.)
interface HtmlElementOverrides {
  a: { download?: string | boolean | undefined, referrerpolicy?: string | undefined }
  area: { download?: string | boolean | undefined, referrerpolicy?: string | undefined }
  audio: { crossorigin?: string | undefined }
  button: {
    type?: 'button' | 'submit' | 'reset' | undefined
    popovertarget?: string | undefined
    popoverTarget?: string | undefined
    popovertargetaction?: 'hide' | 'show' | 'toggle' | undefined
    popoverTargetAction?: 'hide' | 'show' | 'toggle' | undefined
    formaction?: string | ((...args: never[]) => unknown) | undefined
    formenctype?: string | undefined
    formmethod?: string | undefined
    formnovalidate?: boolean | undefined
    formtarget?: string | undefined
  }
  details: { name?: string | undefined, open?: boolean | undefined }
  dialog: { closedby?: 'any' | 'closerequest' | 'none' | undefined }
  form: {
    action?: string | ((...args: never[]) => unknown) | undefined
    method?: 'get' | 'post' | 'dialog' | 'GET' | 'POST' | undefined
    enctype?: string | undefined
    encType?: string | undefined
    novalidate?: boolean | undefined
    noValidate?: boolean | undefined
    autocomplete?: string | undefined
    'accept-charset'?: string | undefined
  }
  iframe: {
    allowfullscreen?: boolean | undefined
    loading?: 'lazy' | 'eager' | undefined
    referrerpolicy?: string | undefined
    sandbox?: string | undefined
    srcdoc?: string | undefined
  }
  img: {
    crossorigin?: string | undefined
    decoding?: 'async' | 'sync' | 'auto' | undefined
    fetchpriority?: 'high' | 'low' | 'auto' | undefined
    fetchPriority?: 'high' | 'low' | 'auto' | undefined
    loading?: 'lazy' | 'eager' | undefined
    referrerpolicy?: string | undefined
    sizes?: string | undefined
    srcset?: string | undefined
    srcSet?: string | undefined
    usemap?: string | undefined
  }
  input: {
    value?: string | number | undefined
    autocomplete?: string | undefined
    maxlength?: number | string | undefined
    minlength?: number | string | undefined
    readonly?: boolean | undefined
    list?: string | undefined
    popovertarget?: string | undefined
    popoverTarget?: string | undefined
    popovertargetaction?: 'hide' | 'show' | 'toggle' | undefined
    popoverTargetAction?: 'hide' | 'show' | 'toggle' | undefined
    formaction?: string | ((...args: never[]) => unknown) | undefined
    formenctype?: string | undefined
    formmethod?: string | undefined
    formnovalidate?: boolean | undefined
    formtarget?: string | undefined
  }
  label: { for?: string | undefined, htmlFor?: string | undefined }
  link: {
    as?: string | undefined
    crossorigin?: string | undefined
    fetchpriority?: 'high' | 'low' | 'auto' | undefined
    imagesizes?: string | undefined
    imagesrcset?: string | undefined
    referrerpolicy?: string | undefined
  }
  meta: {
    charset?: string | undefined
    charSet?: string | undefined
    'http-equiv'?: string | undefined
    property?: string | undefined
  }
  ol: { reversed?: boolean | undefined, start?: number | string | undefined }
  option: { value?: string | number | undefined, selected?: boolean | undefined, disabled?: boolean | undefined }
  output: { for?: string | undefined, htmlFor?: string | undefined }
  script: {
    crossorigin?: string | undefined
    fetchpriority?: 'high' | 'low' | 'auto' | undefined
    nomodule?: boolean | undefined
    referrerpolicy?: string | undefined
  }
  select: {
    value?: string | number | undefined
    autocomplete?: string | undefined
    multiple?: boolean | undefined
  }
  source: {
    media?: string | undefined
    sizes?: string | undefined
    srcset?: string | undefined
    srcSet?: string | undefined
    type?: string | undefined
    width?: number | string | undefined
    height?: number | string | undefined
  }
  td: { colspan?: number | string | undefined, rowspan?: number | string | undefined, headers?: string | undefined }
  textarea: {
    value?: string | number | undefined
    autocomplete?: string | undefined
    maxlength?: number | string | undefined
    minlength?: number | string | undefined
    readonly?: boolean | undefined
  }
  th: { colspan?: number | string | undefined, rowspan?: number | string | undefined, headers?: string | undefined, scope?: string | undefined }
  time: { datetime?: string | undefined, dateTime?: string | undefined }
  video: { crossorigin?: string | undefined, playsinline?: boolean | undefined, playsInline?: boolean | undefined }
}

type HtmlIntrinsicElements = {
  [K in keyof HTMLElementTagNameMap]:
  K extends keyof HtmlElementOverrides
    ? Omit<HTMLAttributes<HTMLElementTagNameMap[K]>, keyof HtmlElementOverrides[K]> & HtmlElementOverrides[K]
    : HTMLAttributes<HTMLElementTagNameMap[K]>
}

export interface SVGAttributes<T extends SVGElement = SVGElement> extends CommonAttributes<T> {
  xmlns?: string | undefined
  'xmlns:xlink'?: string | undefined
  viewBox?: string | undefined
  preserveAspectRatio?: string | undefined
  width?: number | string | undefined
  height?: number | string | undefined
  x?: number | string | undefined
  y?: number | string | undefined
  x1?: number | string | undefined
  y1?: number | string | undefined
  x2?: number | string | undefined
  y2?: number | string | undefined
  cx?: number | string | undefined
  cy?: number | string | undefined
  r?: number | string | undefined
  rx?: number | string | undefined
  ry?: number | string | undefined
  dx?: number | string | undefined
  dy?: number | string | undefined
  d?: string | undefined
  points?: string | undefined
  pathLength?: number | string | undefined
  fill?: string | undefined
  'fill-opacity'?: number | string | undefined
  'fill-rule'?: 'nonzero' | 'evenodd' | 'inherit' | undefined
  stroke?: string | undefined
  'stroke-width'?: number | string | undefined
  'stroke-linecap'?: 'butt' | 'round' | 'square' | 'inherit' | undefined
  'stroke-linejoin'?: 'miter' | 'round' | 'bevel' | 'inherit' | undefined
  'stroke-miterlimit'?: number | string | undefined
  'stroke-dasharray'?: number | string | undefined
  'stroke-dashoffset'?: number | string | undefined
  'stroke-opacity'?: number | string | undefined
  opacity?: number | string | undefined
  color?: string | undefined
  transform?: string | undefined
  'transform-origin'?: string | undefined
  'clip-path'?: string | undefined
  'clip-rule'?: 'nonzero' | 'evenodd' | 'inherit' | undefined
  mask?: string | undefined
  filter?: string | undefined
  'pointer-events'?: string | undefined
  'vector-effect'?: string | undefined
  'shape-rendering'?: string | undefined
  'text-anchor'?: 'start' | 'middle' | 'end' | 'inherit' | undefined
  'dominant-baseline'?: string | undefined
  'font-family'?: string | undefined
  'font-size'?: number | string | undefined
  'font-weight'?: number | string | undefined
  'letter-spacing'?: number | string | undefined
  href?: string | undefined
  'xlink:href'?: string | undefined
  target?: string | undefined
  offset?: number | string | undefined
  'stop-color'?: string | undefined
  'stop-opacity'?: number | string | undefined
  gradientUnits?: string | undefined
  gradientTransform?: string | undefined
  spreadMethod?: string | undefined
  patternUnits?: string | undefined
  patternContentUnits?: string | undefined
  patternTransform?: string | undefined
  clipPathUnits?: string | undefined
  maskUnits?: string | undefined
  maskContentUnits?: string | undefined
  markerWidth?: number | string | undefined
  markerHeight?: number | string | undefined
  refX?: number | string | undefined
  refY?: number | string | undefined
  orient?: number | string | undefined
  'marker-start'?: string | undefined
  'marker-mid'?: string | undefined
  'marker-end'?: string | undefined
  in?: string | undefined
  in2?: string | undefined
  result?: string | undefined
  stdDeviation?: number | string | undefined
  mode?: string | undefined
  operator?: string | undefined
  type?: string | undefined
  values?: string | undefined
  'flood-color'?: string | undefined
  'flood-opacity'?: number | string | undefined
  scale?: number | string | undefined
  surfaceScale?: number | string | undefined
  specularConstant?: number | string | undefined
  specularExponent?: number | string | undefined
  attributeName?: string | undefined
  from?: number | string | undefined
  to?: number | string | undefined
  dur?: string | undefined
  repeatCount?: number | string | undefined
  begin?: string | undefined
  end?: string | undefined
  keyTimes?: string | undefined
  keySplines?: string | undefined
  calcMode?: string | undefined
  focusable?: 'true' | 'false' | 'auto' | boolean | undefined
  // Refuse React's camelCase SVG spellings in types too (SVG attributes are case-sensitive).
  strokeWidth?: never
  strokeLinecap?: never
  strokeLinejoin?: never
  fillOpacity?: never
  fillRule?: never
  clipPath?: never
  clipRule?: never
  xlinkHref?: never
}

// Tags shared by HTML and SVG keep their HTML definitions (already typed above), while SVG-only tags get SVGAttributes.
type SvgOnlyTagName = Exclude<keyof SVGElementTagNameMap, keyof HTMLElementTagNameMap>

type SvgIntrinsicElements = {
  [K in SvgOnlyTagName]: SVGAttributes<SVGElementTagNameMap[K]>
}

export namespace JSX {
  export type Element = KayChild
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ElementType = keyof IntrinsicElements | ((props: any) => KayChild | Promise<KayChild>)
  export interface IntrinsicAttributes {
    key?: string | number | undefined
    $hydrate?: HydrateStrategy | undefined
  }
  export interface ElementChildrenAttribute {
    children: object
  }
  /** Augment this interface via `declare module 'kay/jsx-runtime'` to register custom elements (`<my-widget>`). */
  export interface CustomElements {}
  export interface IntrinsicElements extends HtmlIntrinsicElements, SvgIntrinsicElements, CustomElements {}
}

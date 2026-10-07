import type { Range } from './dom'
import type { Html } from './html'

// The types `kay check` and the editor read templates against: what a template renders, the elements it uses and the attributes each takes.
// Templates compile to HTML strings and DOM code, never to JSX, so nothing here runs.

type Value = string | number | bigint | boolean | null | undefined

// What an attribute takes: a template writes them as text, so any value that renders as text goes.
type AttributeValue = Value

type ClassValue = Value | Record<string, unknown> | readonly ClassValue[]

type StyleValue = string | Record<string, string | number | null | undefined> | null | undefined

// Event names as templates write them: `onDblClick` for `dblclick`; a one-word event is capitalized, `onClick`.
interface EventWords {
  animationcancel: 'AnimationCancel'
  animationend: 'AnimationEnd'
  animationiteration: 'AnimationIteration'
  animationstart: 'AnimationStart'
  auxclick: 'AuxClick'
  beforeinput: 'BeforeInput'
  beforetoggle: 'BeforeToggle'
  canplay: 'CanPlay'
  canplaythrough: 'CanPlayThrough'
  compositionend: 'CompositionEnd'
  compositionstart: 'CompositionStart'
  compositionupdate: 'CompositionUpdate'
  contextlost: 'ContextLost'
  contextmenu: 'ContextMenu'
  contextrestored: 'ContextRestored'
  dblclick: 'DblClick'
  dragend: 'DragEnd'
  dragenter: 'DragEnter'
  dragleave: 'DragLeave'
  dragover: 'DragOver'
  dragstart: 'DragStart'
  durationchange: 'DurationChange'
  focusin: 'FocusIn'
  focusout: 'FocusOut'
  gotpointercapture: 'GotPointerCapture'
  keydown: 'KeyDown'
  keypress: 'KeyPress'
  keyup: 'KeyUp'
  loadeddata: 'LoadedData'
  loadedmetadata: 'LoadedMetadata'
  loadstart: 'LoadStart'
  lostpointercapture: 'LostPointerCapture'
  mousedown: 'MouseDown'
  mouseenter: 'MouseEnter'
  mouseleave: 'MouseLeave'
  mousemove: 'MouseMove'
  mouseout: 'MouseOut'
  mouseover: 'MouseOver'
  mouseup: 'MouseUp'
  pointercancel: 'PointerCancel'
  pointerdown: 'PointerDown'
  pointerenter: 'PointerEnter'
  pointerleave: 'PointerLeave'
  pointermove: 'PointerMove'
  pointerout: 'PointerOut'
  pointerover: 'PointerOver'
  pointerup: 'PointerUp'
  ratechange: 'RateChange'
  securitypolicyviolation: 'SecurityPolicyViolation'
  selectionchange: 'SelectionChange'
  selectstart: 'SelectStart'
  timeupdate: 'TimeUpdate'
  touchcancel: 'TouchCancel'
  touchend: 'TouchEnd'
  touchmove: 'TouchMove'
  touchstart: 'TouchStart'
  transitioncancel: 'TransitionCancel'
  transitionend: 'TransitionEnd'
  transitionrun: 'TransitionRun'
  transitionstart: 'TransitionStart'
  volumechange: 'VolumeChange'
}

type HandlerName<Name extends string> = `on${Name extends keyof EventWords ? EventWords[Name] : Capitalize<Name>}`

// A handler sees the element it is set on as `currentTarget`.
export type EventHandler<Target, E extends Event> = (event: E & { currentTarget: Target, target: globalThis.Element }) => void

type Handlers<Target, Events> = { [Name in keyof Events & string as HandlerName<Name>]?: Events[Name] extends Event ? EventHandler<Target, Events[Name]> : never }

// What every element takes, whatever its tag.
interface CommonAttributes<Target> {
  'children'?: JSX.Element
  'ref'?: (element: Target) => void
  'innerHTML'?: string
  'textContent'?: string
  'innerText'?: string
  'class'?: ClassValue
  'style'?: StyleValue
  'id'?: AttributeValue
  'title'?: AttributeValue
  'lang'?: AttributeValue
  'dir'?: AttributeValue
  'hidden'?: AttributeValue
  'inert'?: AttributeValue
  'tabindex'?: AttributeValue
  'role'?: AttributeValue
  'slot'?: AttributeValue
  'part'?: AttributeValue
  'exportparts'?: AttributeValue
  'is'?: AttributeValue
  'draggable'?: AttributeValue
  'contenteditable'?: AttributeValue
  'spellcheck'?: AttributeValue
  'translate'?: AttributeValue
  'autofocus'?: AttributeValue
  'autocapitalize'?: AttributeValue
  'accesskey'?: AttributeValue
  'enterkeyhint'?: AttributeValue
  'inputmode'?: AttributeValue
  'nonce'?: AttributeValue
  'popover'?: AttributeValue
  'itemid'?: AttributeValue
  'itemprop'?: AttributeValue
  'itemref'?: AttributeValue
  'itemscope'?: AttributeValue
  'itemtype'?: AttributeValue
  'writingsuggestions'?: AttributeValue
  // Animates the element in an island as an `if`, a `for` row or an `await` shows it and before it goes: `fade` adds `fade-enter-from`, `fade-enter-active`, `fade-enter-to`, and `fade-leave-` likewise.
  'transition'?: string
  // Classes of each phase besides or instead of the named ones, Tailwind's included: `enter` and `leave` throughout, `-from` for the first frame, `-to` after it.
  'transition:enter'?: string
  'transition:enter-from'?: string
  'transition:enter-to'?: string
  'transition:leave'?: string
  'transition:leave-from'?: string
  'transition:leave-to'?: string
  [data: `data-${string}`]: AttributeValue
  [aria: `aria-${string}`]: AttributeValue
}

// An element's own attributes are its DOM properties, by name and lowercased as HTML writes them: `maxLength` or `maxlength`.
// A form or a select indexes its controls, which names no attribute.
type OwnAttributes<Target> = {
  [Name in keyof Target as Name extends keyof HTMLElement ? never : string extends Name ? never : Target[Name] extends (...args: never[]) => unknown ? never : Name extends string ? Name | Lowercase<Name> : never]?: AttributeValue
}

// Attributes HTML spells differently from their property.
interface SpelledAttributes {
  button: { popovertarget?: AttributeValue }
  form: { 'accept-charset'?: AttributeValue }
  input: { popovertarget?: AttributeValue }
  label: { for?: AttributeValue }
  // `property` names an Open Graph tag.
  meta: { 'charset'?: AttributeValue, 'http-equiv'?: AttributeValue, 'property'?: AttributeValue }
  output: { for?: AttributeValue }
}

// kay's own, never written out: a `head` title marked `raw` is left out of `seo.titleTemplate`.
interface KayAttributes {
  title: { raw?: boolean }
}

type HtmlAttributes<Tag extends keyof HTMLElementTagNameMap> = CommonAttributes<HTMLElementTagNameMap[Tag]>
  & Handlers<HTMLElementTagNameMap[Tag], HTMLElementEventMap>
  & OwnAttributes<HTMLElementTagNameMap[Tag]>
  & (Tag extends keyof SpelledAttributes ? SpelledAttributes[Tag] : unknown)
  & (Tag extends keyof KayAttributes ? KayAttributes[Tag] : unknown)

// SVG attributes are no DOM properties to read them off, so an SVG element takes any.
type SvgAttributes<Target> = CommonAttributes<Target> & Handlers<Target, SVGElementEventMap> & Record<string, unknown>

type HtmlElements = { [Tag in keyof HTMLElementTagNameMap]: HtmlAttributes<Tag> }

type SvgElements = { [Tag in Exclude<keyof SVGElementTagNameMap, keyof HTMLElementTagNameMap>]: SvgAttributes<SVGElementTagNameMap[Tag]> }

// A component taking `Props`, such as one passed as a prop to render.
export type Component<Props = object> = (props: Props) => JSX.Element

// eslint-disable-next-line ts/no-namespace -- TypeScript reads JSX types off a namespace named JSX
export namespace JSX {
  // What a template renders, and what a component returns or a slot takes.
  export type Element = Value | Node | Range | Html | readonly Element[] | (() => Element)

  export interface ElementChildrenAttribute {
    children: unknown
  }

  // eslint-disable-next-line ts/consistent-indexed-object-style -- an interface, to extend the element maps
  export interface IntrinsicElements extends HtmlElements, SvgElements {
    // A custom element takes any attribute.
    [tag: `${string}-${string}`]: SvgAttributes<HTMLElement>
  }
}

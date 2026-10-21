// How both renderers read the values a template gives, kay/html into markup and kay/dom into nodes, so a page hydrates into what the server wrote.

import { resolveClasses } from './class-table'
import { kayLog } from './log'
import { isVouched } from './safe-html'

// Whether production has warned of a dropped `innerHTML` yet.
let dropped = false

const ARIA = /^aria-/i
// A name HTML reads as one attribute: a key holding a space, a quote, `=`, `/` or `>` would open others.
const ATTRIBUTE_NAME = /^[^\0-\x20"'>/=\x7F]+$/
// An event handler in any case, as HTML reads attribute names.
const HANDLER = /^on/i
// A tag name HTML reads as one, which a dynamic tag given as text must be.
const ELEMENT_NAME = /^[a-z][^\0-\x20"'>/=\x7F]*$/i
// A whole document in a frame, which no spread sets.
const DOCUMENT = /^srcdoc$/i

export function attributeName(name: string): boolean {
  return ATTRIBUTE_NAME.test(name)
}

// The tag a dynamic tag names, refused when HTML would read it as something else, such as `img src=x onerror=...`.
export function elementName(tag: string): string {
  if (!ELEMENT_NAME.test(tag))
    throw new Error(`kay: ${JSON.stringify(tag)} is not an element name`)

  return tag
}

export function handlerName(name: string): boolean {
  return HANDLER.test(name)
}

// What a spread onto an element may set, as it often carries data, such as a record's fields: attribute names only, handlers only as functions an island attaches, no `srcdoc`, and `innerHTML` only as markup `trustHtml`, `sanitizeHtml` or an icon import vouched for; getters are kept, so a prop stays live.
export function spreadAttributes<T>(source: T): T {
  if (source == null || typeof source !== 'object')
    return source

  const kept = {}

  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
    if (!ATTRIBUTE_NAME.test(name) || DOCUMENT.test(name))
      continue

    if (HANDLER.test(name) && typeof (descriptor.get ? (source as Record<string, unknown>)[name] : descriptor.value) !== 'function')
      continue

    Object.defineProperty(kept, name, name === 'innerHTML' ? { get: () => vouchedMarkup(descriptor.get ? (source as Record<string, unknown>)[name] : descriptor.value), enumerable: true } : descriptor)
  }

  return kept as T
}

// The markup of an `innerHTML` a spread brings, or nothing when none vouched for it: warned of in development each time, in production once per process.
function vouchedMarkup(value: unknown): unknown {
  if (value == null || isVouched(value))
    return value

  const production = process.env.NODE_ENV === 'production'

  if (!production || !dropped) {
    dropped = production
    kayLog('warn', 'a spread brought an `innerHTML` that nothing vouched for, so it was dropped: pass sanitizeHtml(value) for markup a user wrote, or trustHtml(value) for markup the app made, called where it is used, as the process keeps only the markup most recently vouched for, for every user. Markup read from a request, a cookie or localStorage has to be vouched for again.')
  }

  return undefined
}

// Props from several objects, later ones winning, each keeping its getters, so a prop stays live and a spread `children` renders only when read.
export function merge(...sources: readonly object[]): Record<string, unknown> {
  const props = {}

  for (const source of sources) {
    if (source != null)
      Object.defineProperties(props, Object.getOwnPropertyDescriptors(source))
  }

  return props
}

// The props a component left out of its destructuring, getters kept.
export function omit(props: object, ...keys: string[]): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(props)

  for (const key of keys)
    delete descriptors[key]

  return Object.defineProperties({}, descriptors)
}

// What an attribute is given: `false` leaves it out, as `null` and `undefined` do, and `true` writes it bare, but for an ARIA state, which takes them as `"true"` or `"false"`.
export function attributeValue(name: string, value: unknown): string | boolean {
  if (value == null || (value === false && !ARIA.test(name)))
    return false

  return value === true && !ARIA.test(name) ? true : String(value)
}

// A `class` given as an array: nested arrays flattened, an object's keys kept with their values, other truthy values as names.
export function flattenClasses(list: readonly unknown[], result: Record<string, unknown>): Record<string, unknown> {
  for (const item of list) {
    if (Array.isArray(item))
      flattenClasses(item, result)
    else if (typeof item === 'object' && item !== null)
      Object.assign(result, item)
    else if (typeof item !== 'boolean' && (Boolean(item) || item === 0))
      result[String(item)] = true
  }

  return result
}

// A `class` value: a string, or an array or object of classes, an object's keys kept when their value is truthy.
// An array is several sources merged, so a Tailwind class a later one overrides is left out; see `resolveClasses`.
export function classText(value: unknown): string {
  if (typeof value === 'number')
    return String(value)

  if (value == null || value === false || value === '')
    return ''

  if (typeof value === 'string')
    return value

  const classes = Array.isArray(value) ? flattenClasses(value, {}) : value as Record<string, unknown>
  let result = ''

  for (const key of Object.keys(classes)) {
    if (key !== '' && key !== 'undefined' && Boolean(classes[key]))
      result += result ? ` ${key}` : key
  }

  return Array.isArray(value) ? resolveClasses(result) : result
}

// The `class` a component gets when its call merges a shorthand, a `class` attribute or a spread's: one string, as a `class?: string` prop takes it, or none when nothing is set.
export function componentClass(list: readonly unknown[]): unknown {
  const parts = list.find(isParts)

  if (parts === undefined)
    return classText(list) || undefined

  const rest = list.filter(item => item !== parts)

  return rest.length === 0 ? parts : taggedParts({ ...parts, root: [...rest, parts.root] })
}

const PARTS = Symbol.for('kay.parts')

type Parts = Record<string, unknown> & { readonly [PARTS]?: true }

// An object of classes by part name, as a part that is a component hands it: told from a `{ class: condition }` object, which a plain `class` takes.
function isParts(value: unknown): value is Parts {
  return typeof value === 'object' && value !== null && (value as Parts)[PARTS] === true
}

function taggedParts(parts: Record<string, unknown>): Parts {
  return Object.defineProperty({ ...parts }, PARTS, { value: true })
}

// What a component's `class` prop gives a part: a string, or an array, is the root's, and an object holds one entry per part, its own object when that part is a component.
export function partClass(props: unknown, part: string): unknown {
  const value = (props as { class?: unknown } | undefined)?.class

  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return part === 'root' ? value : undefined

  const entry = (value as Record<string, unknown>)[part]

  return typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? taggedParts(entry as Record<string, unknown>) : entry
}

// A `style` value: a string, or an object of properties, each kept unless `null` or `undefined`; empty when it is falsy.
export function styleText(value: unknown): string {
  if (Boolean(value) === false)
    return ''

  if (typeof value === 'string')
    return value

  let result = ''

  for (const [name, property] of Object.entries(value as Record<string, unknown>)) {
    if (property != null)
      result += `${result ? ';' : ''}${name}:${String(property)}`
  }

  return result
}

// A child value, part by part: a string or a number as its text, `null`, `undefined`, a boolean and a symbol as nothing, a function as what it returns, an array item by item; any other object as it is, for the renderer to read.
export function eachChild(value: unknown, part: (part: string | object, original?: unknown) => void): void {
  if (value == null || typeof value === 'boolean' || typeof value === 'symbol')
    return

  if (typeof value === 'function') {
    eachChild((value as () => unknown)(), part)
  }
  else if (Array.isArray(value)) {
    for (const item of value)
      eachChild(item, part)
  }
  else {
    part(typeof value === 'object' ? value : String(value), value)
  }
}

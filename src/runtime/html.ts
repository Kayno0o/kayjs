// What pages, layouts and static components render to on the server: markup built as strings, with no reactive runtime.
// A rendered value is `{ t: markup }`: what a component or an island rendered goes into its parent's markup as it is.

import { escape, escapeAttribute } from './escape'
import { currentServerScope, scope } from './reactive'

export { escape, escapeAttribute } from './escape'
export { head } from './head'

export interface Html {
  t: string
}

// Leads the markup of a `try` block the server rendered its `catch` block for.
export const FAILED_MARKER = '<!--kay-failed-->'
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'menuitem', 'meta', 'param', 'source', 'track', 'wbr'])
// Properties that set an element's content rather than an attribute.
const CONTENT_PROPERTIES = new Set(['innerHTML', 'textContent', 'innerText', 'children'])
// Handlers and refs, which only an island attaches; `open` is the one attribute starting with `on` that is none.
const BEHAVIOUR = /^(?:on(?!en$)|ref$)/
const OPTION = /<option(?=[\s>])([^>]*)>([\s\S]*?)(?=<\/option>|<option[\s>]|<\/select>|$)/g
const OPTION_VALUE = /\svalue="([^"]*)"/
const SELECTED = /\sselected(?=[\s=>]|$)/
const TAGS = /<[^>]*>/g
const SPACES = /\s+/g
const HTML_ENTITY = /&(?:amp|lt|gt|quot|#39);/g
const DECODED: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'' }

// A child value's markup: text escaped, numbers as they are, `null`, `undefined` and booleans as nothing, arrays item by item, functions as what they return.
export function child(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return escape(value)
    case 'number':
    case 'bigint':
      return String(value)
    case 'function':
      return child((value as () => unknown)())
    case 'object':
      if (value === null)
        return ''

      if (Array.isArray(value)) {
        let markup = ''

        for (const item of value)
          markup += child(item)

        return markup
      }

      return rendered(value)
    default:
      return ''
  }
}

// Inside `script` and `style`, whose text the browser never decodes.
export function raw(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'bigint':
      return String(value)
    case 'function':
      return raw((value as () => unknown)())
    case 'object':
      if (value === null)
        return ''

      if (Array.isArray(value)) {
        let markup = ''

        for (const item of value)
          markup += raw(item)

        return markup
      }

      return rendered(value)
    default:
      return ''
  }
}

function rendered(value: object): string {
  const { t } = value as { t?: unknown }

  return typeof t === 'string' ? t : ''
}

// ` name="value"`, ` name` for `true`, nothing for `null`, `undefined` and `false`.
export function attribute(name: string, value: unknown): string {
  if (value == null || value === false)
    return ''

  return value === true ? ` ${name}` : ` ${name}="${escapeAttribute(String(value))}"`
}

// A `class` value: a string, or an array or object of classes, an object's keys kept when their value is truthy.
export function className(value: unknown): string {
  if (typeof value === 'number')
    return String(value)

  if (!value)
    return ''

  if (typeof value === 'string')
    return escapeAttribute(value)

  const classes = Array.isArray(value) ? flattenClasses(value, {}) : value as Record<string, unknown>
  let result = ''

  for (const key of Object.keys(classes)) {
    if (!key || key === 'undefined' || !classes[key])
      continue

    result += result ? ` ${escapeAttribute(key)}` : escapeAttribute(key)
  }

  return result
}

function flattenClasses(list: readonly unknown[], result: Record<string, unknown>): Record<string, unknown> {
  for (const item of list) {
    if (Array.isArray(item))
      flattenClasses(item, result)
    else if (typeof item === 'object' && item !== null)
      Object.assign(result, item)
    else if (typeof item !== 'boolean' && (item || item === 0))
      result[String(item)] = true
  }

  return result
}

// A `style` value: a string, or an object of properties, each kept unless `null` or `undefined`.
export function style(value: unknown): string {
  if (!value)
    return ''

  if (typeof value === 'string')
    return escapeAttribute(value)

  let result = ''

  for (const [name, property] of Object.entries(value as Record<string, unknown>)) {
    if (property == null)
      continue

    result += `${result ? ';' : ''}${escapeAttribute(name)}:${escapeAttribute(String(property))}`
  }

  return result
}

// An element whose attributes are only known at render time: spreads, or a component tag that names an element.
// An attribute set by several sources takes the last one's value and place; `content`, the markup of the lines under the tag, wins over a `children` or `innerHTML` property.
export function element(tag: string, sources: readonly object[], content?: () => string): Html {
  const isVoid = VOID_ELEMENTS.has(tag)
  const isRaw = tag === 'script' || tag === 'style'
  let markup = `<${tag}`
  let inner = content?.()
  let selected: unknown

  for (const [index, source] of sources.entries()) {
    if (source == null)
      continue

    for (const name of Object.keys(source)) {
      if (sources.some((later, position) => position > index && later != null && Object.hasOwn(later, name)))
        continue

      const value = (source as Record<string, unknown>)[name]

      if (tag === 'textarea' && (name === 'value' || name === 'defaultValue')) {
        if (inner === undefined && value != null)
          inner = escape(String(value))

        continue
      }

      if (CONTENT_PROPERTIES.has(name)) {
        if (inner === undefined && !isVoid)
          inner = isRaw || name === 'innerHTML' ? raw(value) : child(value)

        continue
      }

      if (value == null || BEHAVIOUR.test(name))
        continue

      if (name === 'value')
        selected = value

      if (name === 'class')
        markup += ` class="${className(value)}"`
      else if (name === 'style')
        markup += ` style="${style(value)}"`
      else if (value === '')
        markup += ` ${escape(name)}`
      else
        markup += attribute(escape(name), value)
    }
  }

  if (isVoid)
    return { t: `${markup}>` }

  if (tag === 'select' && selected !== undefined && inner !== undefined)
    inner = selectOptions(selected, inner)

  return { t: `${markup}>${inner ?? ''}</${tag}>` }
}

// A component tag read off a prop or through a call: a string names an element, a function is the component.
export function dynamic(tag: unknown, props: object): unknown {
  if (typeof tag === 'string')
    return element(tag, [props])

  return typeof tag === 'function' ? component(tag as (props: object) => unknown, props) : undefined
}

// Calls a component under an owner of its own, so what it provides reaches only what it renders.
export function component<P>(fn: (props: P) => unknown, props: P): unknown {
  return scope(() => fn(props))
}

// Props from several objects, later ones winning, each keeping its getters, so a spread `children` still renders only when read.
export function merge(...sources: readonly object[]): object {
  const props = {}

  for (const source of sources) {
    if (source != null)
      Object.defineProperties(props, Object.getOwnPropertyDescriptors(source))
  }

  return props
}

// The props a component left out of its destructuring, getters kept.
export function omit(props: object, ...keys: string[]): object {
  const descriptors = Object.getOwnPropertyDescriptors(props)

  for (const key of keys)
    delete descriptors[key]

  return Object.defineProperties({}, descriptors)
}

// A `try` block: what it renders, or once that throws, its `catch` block, the error reported. The marker tells an island hydrating to keep that markup as it came, since the error stayed on the server.
export function attempt(render: () => string, fallback?: (error: unknown) => string): string {
  try {
    return render()
  }
  catch (error) {
    const server = currentServerScope()

    if (server)
      server.report(error)
    else
      console.error(error)

    return FAILED_MARKER + (fallback?.(error) ?? '')
  }
}

// An `if` naming its value: the branch reads it through a function, as the island build of the same template does.
export function show<T>(value: T, render: (value: () => NonNullable<T>) => string, fallback?: () => string): string {
  if (!value)
    return fallback?.() ?? ''

  return render(() => value as NonNullable<T>)
}

// A `for`: each row's markup, or the fallback's when there is nothing to list.
// In an island a row reads its item, and a keyed row its index, through functions, as the browser build of the same template does.
export function loop<T>(each: readonly T[] | null | undefined | false, render: (item: T | (() => T), index: number | (() => number)) => string, fallback?: () => string, accessors?: 'keyed' | 'positional'): string {
  if (!each || each.length === 0)
    return fallback?.() ?? ''

  let markup = ''

  for (let index = 0; index < each.length; index++) {
    const item = each[index]!

    if (accessors === undefined)
      markup += render(item, index)
    else
      markup += render(() => item, accessors === 'keyed' ? () => index : index)
  }

  return markup
}

// A `select` given a value marks the options it holds as selected, matching an option's `value`, or its text when it has none.
export function selectOptions(value: unknown, markup: string): string {
  const values = Array.isArray(value) ? value.map(String) : [String(value)]

  return markup.replace(OPTION, (option: string, attributes: string, text: string) => {
    if (SELECTED.test(attributes))
      return option

    const valueAttribute = OPTION_VALUE.exec(attributes)
    const optionValue = valueAttribute ? decode(valueAttribute[1]!) : decode(text.replace(TAGS, '')).replace(SPACES, ' ').trim()

    return values.includes(optionValue) ? `<option${attributes} selected>${text}` : option
  })
}

function decode(text: string): string {
  return text.replace(HTML_ENTITY, match => DECODED[match]!)
}

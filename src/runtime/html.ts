// What pages, layouts and static components render to on the server: markup built as strings, with no reactive runtime.
// A rendered value is `{ t: markup }`: what a component or an island rendered goes into its parent's markup as it is.

import { flattenClasses } from './classes'
import { escape, escapeAttribute } from './escape'
import { localizedLink } from './i18n'
import { imageSource } from './image'
import { localeState } from './locale-state'
import { currentServerScope, scope } from './reactive'
import { ISLAND_PARAM } from './server-islands'
import { failedIds, idMark } from './uid'
import { safeUrl } from './url'

export { componentClass } from './classes'
export { escape, escapeAttribute } from './escape'
export { head } from './head'
export { untrack } from './reactive'

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
// What ends a `script` or `style` early, or opens a comment that keeps a script running past its end tag.
const RAW_TEXT_BREAK = /<\/(?=script|style)|<!--/gi
const OPTION = /<option(?=[\s>])([^>]*)>([\s\S]*?)(?=<\/option>|<option[\s>]|<\/select>|$)/g
const OPTION_VALUE = /\svalue="([^"]*)"/
const SELECTED = /\sselected(?=[\s=>]|$)/
const SELECTED_ALL = /\sselected(?:="[^"]*")?(?=[\s>]|$)/g
const TAGS = /<[^>]*>/g
const SPACES = /\s+/g
const HTML_ENTITY = /&(?:amp|lt|gt|quot|#39);/g
const TRAILING_SLASH = /(?<=.)\/$/
const ARIA = /^aria-/i
const DECODED: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'' }
const LINK_TAG = /<a\s[^>]*>/gi
const LINK_HREF = /(\shref=")([^"]*)"/i
const HREFLANG = /\shreflang=/i

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
    case 'boolean':
    case 'symbol':
    case 'undefined':
    default:
      return ''
  }
}

// Inside `script` and `style`, whose text the browser never decodes: a value may not close the element or open a comment there.
// `\/` and `\!` read as `/` and `!` in JavaScript strings and in CSS alike.
export function raw(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value.replace(RAW_TEXT_BREAK, match => match === '<!--' ? '<\\!--' : '<\\/')
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
    case 'boolean':
    case 'symbol':
    case 'undefined':
    default:
      return ''
  }
}

function rendered(value: object): string {
  const { t } = value as { t?: unknown }

  return typeof t === 'string' ? t : ''
}

// ` name="value"`, ` name` for `true`, nothing for `null`, `undefined` and `false`; an ARIA state takes a boolean as `"true"` or `"false"`.
export function attribute(name: string, value: unknown): string {
  if (value == null || (value === false && !ARIA.test(name)))
    return ''

  return value === true && !ARIA.test(name) ? ` ${name}` : ` ${name}="${escapeAttribute(safeUrl(name, String(value)))}"`
}

// A link of the site in the locale of the page rendering it; see `localizedLink`.
export function localHref(href: unknown): unknown {
  const state = localeState()

  return state === undefined || state.implicit || typeof href !== 'string' ? href : localizedLink(state.settings, href, state.locale, state.host)
}

// The links of markup the page did not compile, such as a Markdown entry's, in its locale, but those carrying `hreflang`.
export function localLinks(markup: string): string {
  if (localeState() === undefined)
    return markup

  return markup.replace(LINK_TAG, tag => HREFLANG.test(tag) ? tag : tag.replace(LINK_HREF, (_, start: string, href: string) => `${start}${escapeAttribute(localHref(decode(href)) as string)}"`))
}

// ` aria-current="page"` on a link to the page being rendered: the same path, a trailing slash or not; a link with a query or a fragment leads elsewhere on it.
export function currentPage(href: unknown): string {
  const path = currentServerScope()?.path

  if (path === undefined || typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//') || href.includes('?') || href.includes('#'))
    return ''

  return new URL(href, 'http://localhost').pathname.replace(TRAILING_SLASH, '') === path.replace(TRAILING_SLASH, '') ? ' aria-current="page"' : ''
}

// A `class` value: a string, or an array or object of classes, an object's keys kept when their value is truthy.
export function className(value: unknown): string {
  if (typeof value === 'number')
    return String(value)

  if (value == null || value === false || value === '')
    return ''

  if (typeof value === 'string')
    return escapeAttribute(value)

  const classes = Array.isArray(value) ? flattenClasses(value, {}) : value as Record<string, unknown>
  let result = ''

  for (const key of Object.keys(classes)) {
    if (key === '' || key === 'undefined' || Boolean(classes[key]) === false)
      continue

    result += result ? ` ${escapeAttribute(key)}` : escapeAttribute(key)
  }

  return result
}

// A `style` value: a string, or an object of properties, each kept unless `null` or `undefined`.
export function style(value: unknown): string {
  if (Boolean(value) === false)
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
      else if (tag === 'a' && name === 'href' && !sources.some(later => later != null && Object.hasOwn(later, 'hreflang')))
        markup += attribute(name, localHref(value))
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

export type ServerIslandMode = 'inline' | 'defer'

// A page render looking for its server islands. Scanning renders every component, noting those a server island sits in; otherwise only those render, the rest of the page coming from its prerendered copy.
export interface ServerIslands {
  scanning: boolean
  path: Set<unknown>
  // Each server island's markup, in page order.
  html: string[]
  modes: ServerIslandMode[]
  stack: unknown[]
  inside: number
  // Islands this request has no use for, left unrendered: a scan renders them all.
  skip?: ServerIslandMode | undefined
}

let islands: ServerIslands | undefined

// Calls a component under an owner of its own, so what it provides reaches only what it renders.
export function component<P>(fn: (props: P) => unknown, props: P): unknown {
  return islands ? throughServerIslands(islands, fn, props) : scope(() => fn(props))
}

export function newServerIslands(scanning: boolean, path = new Set<unknown>(), skip?: ServerIslandMode): ServerIslands {
  return { scanning, path, html: [], modes: [], stack: [], inside: 0, skip }
}

export function withServerIslands<T>(state: ServerIslands, render: () => T): T {
  const outer = islands

  islands = state

  try {
    return render()
  }
  finally {
    islands = outer
  }
}

// Whether this is the build rendering a prerendered page, outside its server islands: what must be new on every request, as a form's stamp, is left for the server to fill in.
export function prerendering(): boolean {
  return islands?.scanning === true && islands.inside === 0
}

function throughServerIslands<P>(state: ServerIslands, fn: (props: P) => unknown, props: P): unknown {
  if (state.inside > 0)
    return scope(() => fn(props))

  if (!state.scanning)
    return state.path.has(fn) ? scope(() => fn(props)) : undefined

  state.stack.push(fn)

  try {
    return scope(() => fn(props))
  }
  finally {
    state.stack.pop()
  }
}

// Where each server island sits in a prerendered page, between two comments the server splits the page at.
export const SERVER_ISLAND = /<!--kay-server:(\d+)-->[\s\S]*?<!--\/kay-server:\1-->/g
// What could post a form: the fields' names and where it goes.
const POSTING_TAG = /<(?:form|input|select|textarea|button)\s[^>]*>/g
const POSTING_ATTRIBUTE = /\s(?:name|action|formaction)="[^"]*"/g

// A component the server renders per request inside a prerendered page: spliced into it for `inline`, fetched by the browser on approach for `defer`.
// Outside a page looking for them, as when the whole page renders per request, it renders as any component does.
// `noscript` is the text of a link to the page with a deferred island in place, for a browser without JavaScript.
export function serverIsland<P>(fn: (props: P) => unknown, props: P, mode: ServerIslandMode, noscript?: unknown): unknown {
  const state = islands

  if (!state || state.inside > 0)
    return component(fn, props)

  if (!state.scanning && mode === state.skip) {
    state.html.push('')

    return undefined
  }

  state.inside++

  let html: string

  try {
    html = child(component(fn, props))
  }
  finally {
    state.inside--
  }

  const index = state.html.push(html) - 1

  if (!state.scanning)
    return undefined

  for (const owner of state.stack)
    state.path.add(owner)

  state.modes.push(mode)

  // The copy a deferred island shows until the browser fetches its own has its size, inert and with nothing it could post, as what it holds is from the build.
  const placeholder = mode === 'defer' ? `<slot data-kay-server="${index}" inert>${html.replace(POSTING_TAG, tag => tag.replace(POSTING_ATTRIBUTE, ''))}</slot>${noscript == null ? '' : `<noscript><a href="?${ISLAND_PARAM}" rel="nofollow">${child(noscript)}</a></noscript>`}` : ''

  return { t: `<!--kay-server:${index}-->${placeholder}<!--/kay-server:${index}-->` }
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
  const mark = idMark()

  try {
    return render()
  }
  catch (error) {
    const server = currentServerScope()

    if (server)
      server.report(error)
    else
      console.error(error)

    return FAILED_MARKER + failedIds(mark, () => fallback?.(error) ?? '')
  }
}

// An `if` naming its value: the branch reads it through a function, as the island build of the same template does.
export function show<T>(value: T, render: (value: () => NonNullable<T>) => string, fallback?: () => string): string {
  if (Boolean(value) === false)
    return fallback?.() ?? ''

  return render(() => value as NonNullable<T>)
}

// A `for`: each row's markup, or the fallback's when there is nothing to list.
// In an island a row reads its item, and a keyed row its index, through functions, as the browser build of the same template does.
export function loop<T>(each: readonly T[] | null | undefined | false, render: (item: T | (() => T), index: number | (() => number)) => string, fallback?: () => string, accessors?: 'keyed' | 'positional'): string {
  if (each == null || each === false || each.length === 0)
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

// A `select` given a value marks the options it holds as selected, matching an option's `value`, or its text when it has none; `only` unselects the others.
export function selectOptions(value: unknown, markup: string, only = false): string {
  const values = Array.isArray(value) ? value.map(String) : [String(value)]

  return markup.replace(OPTION, (option: string, written: string, text: string) => {
    const selected = SELECTED.test(written)

    if (selected && !only)
      return option

    const attributes = selected ? written.replace(SELECTED_ALL, '') : written

    const valueAttribute = OPTION_VALUE.exec(attributes)
    const optionValue = valueAttribute ? decode(valueAttribute[1]!) : decode(text.replace(TAGS, '')).replace(SPACES, ' ').trim()

    return values.includes(optionValue) ? `<option${attributes} selected>${text}` : `<option${attributes}>${text}`
  })
}

// An `img` source, with the variants, `sizes` and size of an imported image.
export function imageAttributes(src: unknown, sized: boolean, sizes?: unknown): string {
  let markup = ''

  for (const [name, value] of Object.entries(imageSource(src, sized, sizes)))
    markup += attribute(name, value)

  return markup
}

// A select a form posting to an action renders: the option a refused post chose, else what its own `value` selects, if it has one.
export function refillOptions(posted: string | undefined, markup: string, value?: () => unknown): string {
  if (posted !== undefined)
    return selectOptions(posted, markup, true)

  return value ? selectOptions(value(), markup) : markup
}

function decode(text: string): string {
  return text.replace(HTML_ENTITY, match => DECODED[match]!)
}

import { resolveClasses } from './class-table'
import { escape, escapeAttribute } from './escape'
import { LOCALE_ATTRIBUTES, ROOT_ATTRIBUTES } from './root'
import { safeUrl } from './url'
import { attributeName, classText, handlerName } from './values'

// A tag a template's `head` block sets, its text as `children`.
export interface HeadTag {
  tag: string
  props: Record<string, unknown>
}

export interface HeadOptions {
  // Tags every page starts from: a tag of the same identity a layout or the page sets replaces one.
  defaults?: HeadTag[] | undefined
  // Wraps a title a layout or the page sets, such as `%s | Site`; a title from the defaults, or one marked `raw`, stays as it is.
  titleTemplate?: string | undefined
  // Fills the social tags a page leaves out from the ones it sets, `og:title` from its title for instance, with `/` URLs made absolute against `origin`.
  social?: SocialOptions | undefined
}

export interface SocialOptions {
  origin?: string | undefined
  // The pixel size of a card image the site serves, by its path, for `og:image:width` and `og:image:height`.
  sizeOf?: ((path: string) => ImageSize | undefined) | undefined
}

export interface ImageSize {
  width: number
  height: number
}

export interface RenderedHead {
  // The page's own charset, base and viewport, which go before anything else.
  prelude: string
  // Its stylesheets and inline styles, ahead of the ones kay links for its components, so these still win a tie.
  styles: string
  html: string
  // The attributes `<html>` takes from the `html` tags, each with a space before it.
  root: string
  // The language a page set with `html(lang)`, which the server uses when there is no i18n.
  lang?: string | undefined
  // Whether the page set its own charset or viewport, which then replace the defaults.
  charset: boolean
  viewport: boolean
}

const HEAD_TAGS = new Set(['title', 'meta', 'link', 'style', 'script', 'base', 'html'])
const RESOURCE_RELS = new Set(['preload', 'modulepreload', 'prefetch', 'preconnect', 'dns-prefetch', 'stylesheet'])
const VOID_TAGS = new Set(['meta', 'link', 'base'])
const META_KEYS = ['name', 'property', 'http-equiv']
// What ends a script early, or opens a comment that keeps it running past its end tag; `\/` and `\!` read as `/` and `!` in its strings.
const SCRIPT_BREAK = /<(\/(?=script)|!(?=--))/gi
// JSON holds `<` only inside strings, where `\u003c` reads the same, so no `<!--` or `</script` survives in it.
const JSON_LT = /</g
const JSON_TYPE = /json/i
// Scripts holding JSON whatever their type says, where `\u003c` keeps them valid and `<\!` would not.
const DATA_SCRIPT = /json|^(?:importmap|speculationrules)$/i
const ABSOLUTE_PATH = /^\/(?!\/)/
const STYLE_END = /<\/(style)/gi
// The meta page-title.ts reads, which stays a copy of its own so the island code is not reachable from the entry.
const TITLE_SETTINGS = 'kay-title'
const VIEWPORT = 'meta:name:viewport'
const OG_IMAGE = 'meta:property:og:image'
const IMAGE_DETAILS = ['meta:property:og:image:width', 'meta:property:og:image:height', 'meta:property:og:image:alt', 'meta:name:twitter:image:alt']
const CHARSET = 'charset'
const SPACES = /\s+/
const NO_ATTRIBUTES: ReadonlyMap<string, string | true> = new Map()

// Renders are synchronous, so the head of the one in progress can live here; a `head` outside a page render sets nothing.
let groups: HeadTag[][] | undefined
// How many islands set a title so far, which counts outside a page render too, as in a server island or an `await` block.
let islandTitles = 0

// Each call is one group: a later group's tag replaces an earlier one's of the same identity, so a page's title wins over its layouts', which register first.
export function head(tags: HeadTag[]): void {
  if (tags.some(tag => tag.tag === 'title' && tag.props.island === true))
    islandTitles++

  groups?.push(tags)
}

// What the head of the render in progress holds, to give back what a block that failed set.
export function headCheckpoint(): [groups: number, titles: number] {
  return [groups?.length ?? 0, islandTitles]
}

export function restoreHead([length, titles]: [number, number]): void {
  if (groups)
    groups.length = length

  islandTitles = titles
}

// Tells whether an island set a title since `mark`.
export function headMark(): number {
  return islandTitles
}

export function setsIslandTitle(mark: number): boolean {
  return islandTitles > mark
}

export function collectHead<T>(render: () => T, options: HeadOptions = {}): { result: T, head: RenderedHead } {
  const previous = groups
  const collected: HeadTag[][] = []

  groups = collected

  try {
    const result = render()

    return { result, head: renderHead(options.defaults ? [options.defaults, ...collected] : collected, options) }
  }
  finally {
    groups = previous
  }
}

// A stylesheet, a preload or a script with a source renders once, where it was first set; any other tag replaces the earlier one of its identity.
function renderHead(collected: HeadTag[][], options: HeadOptions): RenderedHead {
  const resources = new Set<string>()
  const winners = new Map<string, HeadTag[]>()
  let unique = 0
  let rooted = false
  let resourcesHtml = ''
  let styles = ''
  let titleGroup = -1
  // An attribute a later group sets on `<html>` replaces an earlier one's, `false` or `null` taking it off; `class` gathers every group's tokens instead.
  const root: Record<string, unknown> = {}
  let lang: string | undefined

  for (let index = 0; index < collected.length; index++) {
    const group = collected[index]!
    const own = new Map<string, HeadTag[]>()

    for (const tag of group) {
      if (tag == null || !HEAD_TAGS.has(tag.tag))
        continue

      if (tag.tag === 'html') {
        for (const [name, value] of Object.entries(tag.props)) {
          const key = name.toLowerCase()

          if (key === 'lang') {
            lang = typeof value === 'string' && value !== '' ? value : lang

            continue
          }

          if (LOCALE_ATTRIBUTES.has(key))
            continue

          rooted = true
          root[key] = key === 'class' ? joinClasses(root.class as string | undefined, classText(value)) : value
        }

        continue
      }

      if (isResource(tag)) {
        const identity = resourceIdentity(tag)

        if (!resources.has(identity)) {
          resources.add(identity)

          if (tag.props.rel === 'stylesheet')
            styles += tagMarkup(tag)
          else
            resourcesHtml += tagMarkup(tag)
        }

        continue
      }

      const identity = replaceableIdentity(tag) ?? `u:${unique++}`
      const list = own.get(identity)

      if (list)
        list.push(tag)
      else
        own.set(identity, [tag])
    }

    for (const [identity, tags] of own)
      winners.set(identity, identity === 'title' ? [tags.at(-1)!] : tags)

    if (own.has('title'))
      titleGroup = index
  }

  const titleTag = winners.get('title')?.[0]
  const defaultTitle = options.defaults?.find(tag => tag.tag === 'title')
  // A title that comes out empty, from a value the page lacked, shows the site's rather than the template around nothing.
  const useDefault = (options.defaults !== undefined && titleGroup === 0) || (titleTag !== undefined && text(titleTag).trim() === '' && defaultTitle !== undefined)
  const ownTitle = titleTag && text(useDefault && defaultTitle ? defaultTitle : titleTag)
  const raw = Boolean(titleTag?.props.raw)
  const titleText = ownTitle !== undefined && options.titleTemplate !== undefined && options.titleTemplate !== '' && !useDefault && !raw ? options.titleTemplate.replaceAll('%s', () => ownTitle) : ownTitle

  // Social cards show the site name on their own, so they take the title without the template.
  if (options.social)
    fillSocial(winners, ownTitle, options.social, options.defaults ?? [])

  let prelude = ''
  let viewportTag = ''
  let links = ''
  let metas = ''
  let others = ''
  let scripts = ''
  let title = ''

  for (const [identity, tags] of winners) {
    for (const tag of tags) {
      if (identity === 'title')
        title = `<title>${escape(titleText!)}</title>`
      else if (identity === CHARSET || identity === 'base')
        prelude += tagMarkup(tag)
      else if (identity === VIEWPORT)
        viewportTag += tagMarkup(tag)
      else if (tag.tag === 'style')
        styles += tagMarkup(tag)
      else if (tag.tag === 'link')
        links += tagMarkup(tag)
      else if (tag.tag === 'meta')
        metas += tagMarkup(tag)
      else if (tag.tag === 'script')
        scripts += tagMarkup(tag)
      else
        others += tagMarkup(tag)
    }
  }

  // An island goes on setting the title in the browser, which wraps it as the server does.
  if (titleTag?.props.island === true) {
    const settings = {
      ...options.titleTemplate !== undefined && options.titleTemplate !== '' ? { template: options.titleTemplate } : {},
      ...defaultTitle !== undefined ? { fallback: text(defaultTitle) } : {},
    }

    if (Object.keys(settings).length > 0)
      metas += tagMarkup({ tag: 'meta', props: { name: TITLE_SETTINGS, content: JSON.stringify(settings) } })
  }

  const rootAttributes = rooted ? attributesOf(root) : NO_ATTRIBUTES

  if (rootAttributes.size > 0)
    metas += tagMarkup({ tag: 'meta', props: { name: ROOT_ATTRIBUTES, content: servedJson(rootAttributes) } })

  return { prelude: prelude + viewportTag, styles, html: resourcesHtml + links + metas + others + scripts + title, root: markupOf(rootAttributes), lang, charset: winners.has(CHARSET), viewport: winners.has(VIEWPORT) }
}

// The tokens of both, each once where first set, a Tailwind class the later ones override left out, or none when there is no token at all.
function joinClasses(before: string | undefined, added: string): string | undefined {
  const tokens = new Set([...(before ?? '').split(SPACES), ...added.split(SPACES)])

  tokens.delete('')

  return tokens.size === 0 ? undefined : resolveClasses([...tokens].join(' '))
}

// Open Graph and Twitter read their own tags only, so the title, description and canonical URL a page sets are repeated there unless it sets those too.
function fillSocial(winners: Map<string, HeadTag[]>, title: string | undefined, { origin, sizeOf }: SocialOptions, defaults: HeadTag[]): void {
  const content = (identity: string) => winners.get(identity)?.[0]?.props.content as string | undefined
  const fromDefaults = (identity: string) => {
    const tag = winners.get(identity)?.[0]

    return tag !== undefined && defaults.includes(tag)
  }
  const fill = (key: 'name' | 'property', name: string, value: string | undefined) => {
    const identity = `meta:${key}:${name}`

    if (value !== undefined && !winners.has(identity))
      winners.set(identity, [{ tag: 'meta', props: { [key]: name, content: value } }])
  }

  const absolute = (identity: string, attribute: 'content' | 'href') => {
    const tags = winners.get(identity)

    if (origin !== undefined && tags)
      winners.set(identity, tags.map(tag => typeof tag.props[attribute] === 'string' && ABSOLUTE_PATH.test(tag.props[attribute]) ? { tag: tag.tag, props: { ...tag.props, [attribute]: origin + tag.props[attribute] } } : tag))
  }

  const image = content(OG_IMAGE)

  // An image the page sets takes neither the alt text nor the size of the site's.
  if (image !== undefined && !fromDefaults(OG_IMAGE)) {
    for (const identity of IMAGE_DETAILS) {
      if (fromDefaults(identity))
        winners.delete(identity)
    }
  }

  const size = image !== undefined && ABSOLUTE_PATH.test(image) && !winners.has('meta:property:og:image:width') ? sizeOf?.(image) : undefined

  fill('property', 'og:image:width', size && String(size.width))
  fill('property', 'og:image:height', size && String(size.height))
  fill('name', 'twitter:image:alt', content('meta:property:og:image:alt'))

  absolute('link:canonical', 'href')
  absolute('meta:property:og:image', 'content')
  absolute('meta:name:twitter:image', 'content')

  fill('property', 'og:title', title)
  fill('property', 'og:description', content('meta:name:description'))
  fill('property', 'og:url', winners.get('link:canonical')?.[0]?.props.href as string | undefined)

  if (winners.has('meta:property:og:image') || winners.has('meta:name:twitter:image'))
    fill('name', 'twitter:card', 'summary_large_image')
}

function isResource({ tag, props }: HeadTag): boolean {
  if (tag === 'link')
    return RESOURCE_RELS.has(props.rel as string)

  return (tag === 'style' && 'href' in props) || (tag === 'script' && 'src' in props)
}

function resourceIdentity({ tag, props }: HeadTag): string {
  return `${tag}:${String(props.rel ?? '')}:${String(props.href ?? props.src ?? '')}:${String(props.as ?? '')}:${String(props.media ?? '')}:${String(props.type ?? '')}`
}

// Undefined for a tag nothing replaces.
function replaceableIdentity({ tag, props }: HeadTag): string | undefined {
  if (tag === 'title' || tag === 'base')
    return tag

  if (tag === 'meta') {
    if (props.charset != null)
      return CHARSET

    for (const key of META_KEYS) {
      if (props[key] != null)
        return `meta:${key}:${String(props[key])}${props.media != null ? `:media=${String(props.media)}` : ''}`
    }

    return undefined
  }

  if (tag === 'link') {
    const rel = String(props.rel ?? '')

    if (rel === 'canonical')
      return 'link:canonical'

    // One URL per language, which a page may set itself in place of the one kay gives.
    if (rel === 'alternate' && props.hreflang != null)
      return `link:alternate:hreflang=${String(props.hreflang)}`

    if (rel === 'icon' || rel === 'apple-touch-icon')
      return `link:${rel}${props.sizes != null ? `:sizes=${String(props.sizes)}` : ''}${props.type != null ? `:type=${String(props.type)}` : ''}`

    return `link:${rel}:${String(props.href ?? '')}`
  }

  return undefined
}

// The markup of the tags every page starts from, the same objects from one render to the next, which nothing changes once kept.
const keptMarkup = new WeakMap<HeadTag, string>()

export function keepHeadMarkup(tags: HeadTag[]): void {
  for (const tag of tags) {
    if (tag.tag !== 'html' && HEAD_TAGS.has(tag.tag))
      keptMarkup.set(tag, markupNow(tag))
  }
}

function tagMarkup(tag: HeadTag): string {
  return keptMarkup.get(tag) ?? markupNow(tag)
}

function markupNow(tag: HeadTag): string {
  const attributes = markupOf(attributesOf(tag.props))

  if (VOID_TAGS.has(tag.tag))
    return `<${tag.tag}${attributes}>`

  return `<${tag.tag}${attributes}>${tagContent(tag)}</${tag.tag}>`
}

// The attributes a tag renders, by their name in lowercase as HTML reads it, the last of a name winning: `true` for one written bare, none for `false` and `null`.
function attributesOf(props: Record<string, unknown>): Map<string, string | true> {
  const attributes = new Map<string, string | true>()

  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || name === 'ref' || handlerName(name) || !attributeName(name) || value == null || value === false || typeof value === 'function')
      continue

    attributes.set(name.toLowerCase(), value === true ? true : safeUrl(name, String(value)))
  }

  return attributes
}

// The attributes `<html>` takes, as JSON by name for the page swap, which reads one written bare as the browser does, `""`.
function servedJson(attributes: ReadonlyMap<string, string | true>): string {
  return JSON.stringify(Object.fromEntries([...attributes].map(([name, value]) => [name, value === true ? '' : value])))
}

function markupOf(attributes: ReadonlyMap<string, string | true>): string {
  let markup = ''

  for (const [name, value] of attributes)
    markup += value === true ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`

  return markup
}

function tagContent(tag: HeadTag): string {
  if (tag.tag === 'script')
    return scriptText(tag)

  return tag.tag === 'style' ? inlineText(tag) ?? '' : escape(text(tag))
}

// A JSON script, such as JSON-LD, takes its data as an object or as text.
function scriptText(tag: HeadTag): string {
  if (!DATA_SCRIPT.test(String(tag.props.type ?? '')))
    return text(tag).replace(SCRIPT_BREAK, '<\\$1')

  const { children } = tag.props
  const json = typeof children === 'string' ? children : JSON.stringify(children ?? null)

  return json.replace(JSON_LT, '\\u003c')
}

// The text an inline script or style renders with, which the content security policy hashes; undefined for any other tag, a script with a source or a JSON one.
export function inlineText(tag: HeadTag): string | undefined {
  if (tag.props.children == null || (tag.tag !== 'script' && tag.tag !== 'style'))
    return undefined

  if (tag.tag === 'style')
    return text(tag).replace(STYLE_END, '<\\/$1')

  return tag.props.src == null && !JSON_TYPE.test(String(tag.props.type ?? '')) ? scriptText(tag) : undefined
}

function text(tag: HeadTag): string {
  return tag.props.children == null || typeof tag.props.children === 'function' ? '' : String(tag.props.children)
}

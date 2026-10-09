import { escape, escapeAttribute } from './escape'

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
  social?: { origin?: string | undefined } | undefined
}

export interface RenderedHead {
  // The page's own charset, base and viewport, which go before anything else.
  prelude: string
  html: string
  // Whether the page set its own charset or viewport, which then replace the defaults.
  charset: boolean
  viewport: boolean
}

const HEAD_TAGS = new Set(['title', 'meta', 'link', 'style', 'script', 'base'])
const ATTRIBUTE_NAME = /^[a-z_][\w:.-]*$/i
const RESOURCE_RELS = new Set(['preload', 'modulepreload', 'prefetch', 'preconnect', 'dns-prefetch', 'stylesheet'])
const VOID_TAGS = new Set(['meta', 'link', 'base'])
const META_KEYS = ['name', 'property', 'http-equiv']
const SCRIPT_END = /<\/(script)/gi
// JSON holds `<` only inside strings, where `\u003c` reads the same, so no `<!--` or `</script` survives in it.
const JSON_LT = /</g
const JSON_TYPE = /json/i
const ABSOLUTE_PATH = /^\/(?!\/)/
const STYLE_END = /<\/(style)/gi
const VIEWPORT = 'meta:name:viewport'
const CHARSET = 'charset'

// Renders are synchronous, so the head of the one in progress can live here; a `head` outside a page render sets nothing.
let groups: HeadTag[][] | undefined

// Each call is one group: a later group's tag replaces an earlier one's of the same identity, so a page's title wins over its layouts', which register first.
export function head(tags: HeadTag[]): void {
  groups?.push(tags)
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
  let resourcesHtml = ''
  let titleGroup = -1

  for (const [index, group] of collected.entries()) {
    const own = new Map<string, HeadTag[]>()

    for (const tag of group) {
      if (tag == null || !HEAD_TAGS.has(tag.tag))
        continue

      if (isResource(tag)) {
        const identity = resourceIdentity(tag)

        if (!resources.has(identity)) {
          resources.add(identity)
          resourcesHtml += tagMarkup(tag)
        }

        continue
      }

      const identity = replaceableIdentity(tag, () => `u:${unique++}`)
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
    fillSocial(winners, ownTitle, options.social.origin)

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
      else if (tag.tag === 'link' || tag.tag === 'style')
        links += tagMarkup(tag)
      else if (tag.tag === 'meta')
        metas += tagMarkup(tag)
      else if (tag.tag === 'script')
        scripts += tagMarkup(tag)
      else
        others += tagMarkup(tag)
    }
  }

  return { prelude: prelude + viewportTag, html: resourcesHtml + links + metas + others + scripts + title, charset: winners.has(CHARSET), viewport: winners.has(VIEWPORT) }
}

// Open Graph and Twitter read their own tags only, so the title, description and canonical URL a page sets are repeated there unless it sets those too.
function fillSocial(winners: Map<string, HeadTag[]>, title: string | undefined, origin: string | undefined): void {
  const content = (identity: string) => winners.get(identity)?.[0]?.props.content as string | undefined
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

function replaceableIdentity({ tag, props }: HeadTag, unique: () => string): string {
  if (tag === 'title' || tag === 'base')
    return tag

  if (tag === 'meta') {
    if (props.charset != null)
      return CHARSET

    for (const key of META_KEYS) {
      if (props[key] != null)
        return `meta:${key}:${String(props[key])}${props.media != null ? `:media=${String(props.media)}` : ''}`
    }

    return unique()
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

  return unique()
}

function tagMarkup(tag: HeadTag): string {
  let attributes = ''

  for (const [name, value] of Object.entries(tag.props)) {
    if (name === 'children' || name === 'ref' || name.startsWith('on') || !ATTRIBUTE_NAME.test(name) || value == null || value === false)
      continue

    attributes += value === true ? ` ${name}` : ` ${name}="${escapeAttribute(String(value))}"`
  }

  if (VOID_TAGS.has(tag.tag))
    return `<${tag.tag}${attributes}>`

  const content = tag.tag === 'script' ? scriptText(tag) : tag.tag === 'style' ? text(tag).replace(STYLE_END, '<\\/$1') : escape(text(tag))

  return `<${tag.tag}${attributes}>${content}</${tag.tag}>`
}

// A JSON script, such as JSON-LD, takes its data as an object or as text.
function scriptText(tag: HeadTag): string {
  if (!JSON_TYPE.test(String(tag.props.type ?? '')))
    return text(tag).replace(SCRIPT_END, '<\\/$1')

  const { children } = tag.props
  const json = typeof children === 'string' ? children : JSON.stringify(children ?? null)

  return json.replace(JSON_LT, '\\u003c')
}

function text(tag: HeadTag): string {
  return tag.props.children == null ? '' : String(tag.props.children)
}

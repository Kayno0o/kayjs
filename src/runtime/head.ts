import { escape, escapeAttribute } from './escape'

// A tag a template's `head` block sets, its text as `children`.
export interface HeadTag {
  tag: string
  props: Record<string, unknown>
}

export interface RenderedHead {
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
const STYLE_END = /<\/(style)/gi
const VIEWPORT = 'meta:name:viewport'
const CHARSET = 'charset'

// Renders are synchronous, so the head of the one in progress can live here; a `head` outside a page render sets nothing.
let groups: HeadTag[][] | undefined

// Each call is one group: a later group's tag replaces an earlier one's of the same identity, so a page's title wins over its layouts', which register first.
export function head(tags: HeadTag[]): void {
  groups?.push(tags)
}

export function collectHead<T>(render: () => T): { result: T, head: RenderedHead } {
  const previous = groups
  const collected: HeadTag[][] = []

  groups = collected

  try {
    return { result: render(), head: renderHead(collected) }
  }
  finally {
    groups = previous
  }
}

// A stylesheet, a preload or a script with a source renders once, where it was first set; any other tag replaces the earlier one of its identity.
function renderHead(collected: HeadTag[][]): RenderedHead {
  const resources = new Set<string>()
  const winners = new Map<string, HeadTag[]>()
  let unique = 0
  let resourcesHtml = ''

  for (const group of collected) {
    const own = new Map<string, HeadTag[]>()

    for (const tag of group) {
      if (!tag || !HEAD_TAGS.has(tag.tag))
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
  }

  let prelude = ''
  let links = ''
  let metas = ''
  let others = ''
  let scripts = ''
  let title = ''

  for (const [identity, tags] of winners) {
    for (const tag of tags) {
      if (identity === 'title')
        title = `<title>${escape(text(tag))}</title>`
      else if (identity === CHARSET || identity === 'base')
        prelude += tagMarkup(tag)
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

  return { html: prelude + resourcesHtml + links + metas + others + scripts + title, charset: winners.has(CHARSET), viewport: winners.has(VIEWPORT) }
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

  const body = text(tag)
  const content = tag.tag === 'script' ? body.replace(SCRIPT_END, '<\\/$1') : tag.tag === 'style' ? body.replace(STYLE_END, '<\\/$1') : escape(body)

  return `<${tag.tag}${attributes}>${content}</${tag.tag}>`
}

function text(tag: HeadTag): string {
  return tag.props.children == null ? '' : String(tag.props.children)
}

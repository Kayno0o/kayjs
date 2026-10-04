import type { SeoConfig } from '../config'
import type { HeadOptions, HeadTag } from '../runtime/head'

// The head options of one response, from its URL and status.
export type SeoHead = (url: URL, status: number) => HeadOptions

// What `site` and `seo` give every page's head, or undefined when the project sets neither and pages keep only their own tags.
export function seoHead(site: string | undefined, seo: SeoConfig = {}): SeoHead | undefined {
  const origin = site === undefined ? undefined : siteOrigin(site)

  if (origin === undefined && Object.keys(seo).length === 0)
    return undefined

  const tags: HeadTag[] = [meta('property', 'og:type', 'website')]

  if (seo.name !== undefined)
    tags.push({ tag: 'title', props: { children: seo.name } }, meta('property', 'og:site_name', seo.name))

  if (seo.description !== undefined)
    tags.push(meta('name', 'description', seo.description))

  if (seo.image !== undefined)
    tags.push(meta('property', 'og:image', seo.image))

  if (seo.twitter !== undefined)
    tags.push(meta('name', 'twitter:site', seo.twitter))

  if (seo.locale !== undefined)
    tags.push(meta('property', 'og:locale', seo.locale))

  for (const data of seo.jsonLd ?? [])
    tags.push({ tag: 'script', props: { type: 'application/ld+json', children: data } })

  // An error page is no URL to point search engines at.
  return (url, status) => ({
    defaults: origin !== undefined && status === 200 ? [...tags, { tag: 'link', props: { rel: 'canonical', href: origin + url.pathname } }] : tags,
    titleTemplate: seo.titleTemplate,
    social: { origin },
  })
}

// `https://example.com`, with nothing after the host: page paths are appended to it as they are.
export function siteOrigin(site: string): string {
  let url: URL | undefined

  try {
    url = new URL(site)
  }
  catch {}

  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/' || url.search !== '' || url.hash !== '')
    throw new Error(`kay: site is the origin the site is public at, such as https://example.com, not ${JSON.stringify(site)}`)

  return url.origin
}

function meta(key: 'name' | 'property', name: string, content: string): HeadTag {
  return { tag: 'meta', props: { [key]: name, content } }
}

import type { KayConfig, SeoConfig, TrailingSlash } from '../config'
import type { HeadOptions, HeadTag } from '../runtime/head'
import { join } from 'node:path'
import { jsonLd } from '../runtime/seo'
import { faviconTags } from './favicon'
import { builtFonts, fontTags, prepareFonts } from './fonts'
import { slashedPath } from './routes'

// The head options of one response, from its URL and status.
export type SeoHead = (url: URL, status: number) => HeadOptions

// Everything kay.config.ts gives every page's head: the fonts, the favicon, then `site` and `seo`.
// An executable reads the fonts `kay build` recorded, its project being elsewhere; anything else writes them from their files.
export async function configHead(root: string, config: KayConfig, clientDir: string, bundled = false): Promise<SeoHead | undefined> {
  const extra: HeadTag[] = []
  const dir = join(clientDir, '..')

  if (config.fonts !== undefined && config.fonts.length > 0) {
    const fonts = bundled ? await builtFonts(dir) : await prepareFonts(root, config.fonts, dir)

    if (!fonts)
      throw new Error('kay: this executable holds no fonts; build it again with kay build --compile')

    extra.push(...fontTags(fonts))
  }

  if (config.favicon !== undefined)
    extra.push(...faviconTags(config.manifest))

  return seoHead(config.site, config.seo, extra, config.trailingSlash)
}

// What `site`, `seo` and other settings such as the favicon give every page's head, or undefined when the project sets none and pages keep only their own tags.
export function seoHead(site: string | undefined, seo: SeoConfig = {}, extra: HeadTag[] = [], trailingSlash?: TrailingSlash): SeoHead | undefined {
  const origin = site === undefined ? undefined : siteOrigin(site)

  // Fonts or a favicon alone give a page no social card.
  const social = origin !== undefined || Object.keys(seo).length > 0

  if (!social && extra.length === 0)
    return undefined

  const tags: HeadTag[] = social ? [...extra, meta('property', 'og:type', 'website')] : [...extra]

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
    tags.push({ tag: 'script', props: { type: 'application/ld+json', children: jsonLd(data) } })

  // An error page is no URL to point search engines at.
  return (url, status) => ({
    defaults: origin !== undefined && status === 200 ? [...tags, { tag: 'link', props: { rel: 'canonical', href: origin + slashedPath(url.pathname, trailingSlash) } }] : tags,
    titleTemplate: seo.titleTemplate,
    social: social ? { origin } : undefined,
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

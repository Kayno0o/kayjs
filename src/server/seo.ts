import type { KayConfig, SeoConfig, TrailingSlash } from '../config'
import type { HeadOptions, HeadTag, ImageSize } from '../runtime/head'
import type { Localized } from '../runtime/localized'
import type { FontAssets } from './fonts'
import type { LocaleCopy } from './i18n'
import { join } from 'node:path'
import { KayError } from '../compiler/errors'
import { projectPaths } from '../project'
import { inlineText, keepHeadMarkup } from '../runtime/head'
import { CARD, CARD_ROUTE, IMAGE_ROUTE, importedSize, RESIZABLE, VARIANTS } from '../runtime/image'
import { localeState } from '../runtime/locale-state'
import { localizedText } from '../runtime/localized'
import { jsonLd } from '../runtime/seo'
import { basePath } from './base'
import { faviconTags, isOwnManifest, manifestPath } from './favicon'
import { builtFonts, fontTags, prepareFonts } from './fonts'
import { localeCopies } from './i18n'
import { imageHeader } from './image-format'
import { publicFiles } from './public'
import { slashedPath } from './routes'

// The file a prerendered page's `shareCard()` links, where a page served per request links the card route.
const CARD_FILE = /^\/_kay\/images\/card-[\da-z]+\.jpg$/

// The head options of one response, from its URL and status.
export type SeoHead = (url: URL, status: number) => HeadOptions

// Everything kay.config.ts gives every page's head: the fonts, the favicon, its `head`, then `site` and `seo`, with the inline scripts and styles among them for the content security policy, and the fonts themselves, which share cards draw in.
// An executable reads the fonts `kay build` recorded, its project being elsewhere; anything else writes them from their files.
export async function configHead(root: string, config: KayConfig, clientDir: string, bundled = false, appServesManifest = false): Promise<{ head: SeoHead | undefined, scripts: string[], styles: string[], fonts: FontAssets | undefined }> {
  const extra: HeadTag[] = []
  const scripts: string[] = []
  const styles: string[] = []
  const dir = join(clientDir, '..')
  let fonts: FontAssets | undefined

  if (config.fonts !== undefined && config.fonts.length > 0) {
    fonts = bundled ? await builtFonts(dir) : await prepareFonts(root, config.fonts, dir)

    if (!fonts)
      throw new KayError('executable-incomplete', 'kay: this executable holds no fonts; build it again with kay build --compile')

    extra.push(...fontTags(fonts))
    styles.push(fonts.css)
  }

  if (config.favicon !== false)
    extra.push(...faviconTags(config.favicon))

  // A site linking its own icons still colours the browser around its pages.
  extra.push(...themeColorTags(config.seo?.themeColor ?? config.manifest?.themeColor))

  for (const tag of config.head ?? []) {
    const inline = inlineText(tag)

    extra.push(tag)

    if (inline !== undefined)
      (tag.tag === 'script' ? scripts : styles).push(inline)
  }

  const social = config.site !== undefined || config.seo !== undefined
  const sizeOf = social ? await cardImageSizes(projectPaths(root, config).public) : undefined

  return { head: seoHead(config.site, config.seo, extra, config.trailingSlash, basePath(config.base), sizeOf, appServesManifest), scripts, styles, fonts }
}

// One `theme-color` for every visitor, or one per colour scheme the browser reports.
function themeColorTags(color: SeoConfig['themeColor']): HeadTag[] {
  if (color === undefined)
    return []

  if (typeof color === 'string')
    return [{ tag: 'meta', props: { name: 'theme-color', content: color } }]

  return [
    { tag: 'meta', props: { name: 'theme-color', content: color.light, media: '(prefers-color-scheme: light)' } },
    { tag: 'meta', props: { name: 'theme-color', content: color.dark, media: '(prefers-color-scheme: dark)' } },
  ]
}

// The pixel size of a card image named by its path: an imported image's, a public file's, read once here, and a share card's 1200x630.
export async function cardImageSizes(publicDir: string): Promise<(path: string) => ImageSize | undefined> {
  const sizes = new Map<string, ImageSize>()

  await Promise.all((await publicFiles(publicDir)).filter(file => RESIZABLE.test(file.path)).map(async ({ path, url }) => {
    try {
      // Through Bun.file, which reaches the files an executable embeds, where Bun.Image given a path does not.
      const { width, height } = await imageHeader(Bun.file(path))

      sizes.set(url, { width, height })
    }
    catch {}
  }))

  return (path) => {
    const { pathname, searchParams } = new URL(path, 'http://localhost')

    if ((pathname === IMAGE_ROUTE && searchParams.has('card')) || pathname.startsWith(CARD_ROUTE) || CARD_FILE.test(pathname) || (pathname.startsWith(VARIANTS) && pathname.endsWith('-card.jpg')))
      return CARD

    return importedSize(path) ?? sizes.get(pathname)
  }
}

// What `site`, `seo` and other settings such as the favicon give every page's head, or undefined when the project sets none and pages keep only their own tags.
// Every URL it makes absolute goes under `base`, the site's mount point.
export function seoHead(site: string | undefined, seo: SeoConfig = {}, extra: HeadTag[] = [], trailingSlash?: TrailingSlash, base = '', sizeOf?: (path: string) => ImageSize | undefined, appServesManifest = false): SeoHead | undefined {
  const origin = site === undefined ? undefined : siteOrigin(site) + base

  // Fonts or a favicon alone give a page no social card.
  const social = origin !== undefined || Object.keys(seo).length > 0

  if (!social && extra.length === 0)
    return undefined

  // Built once per locale the site is asked for, the text of each default read in that locale.
  const built = new Map<string, { tags: HeadTag[], titleTemplate: string | undefined }>()
  const tagsFor = (locale: string | undefined, defaultLocale: string | undefined) => {
    const key = locale ?? ''
    const known = built.get(key)

    if (known !== undefined)
      return known

    const text = (value: Localized | undefined) => localizedText(value, locale, defaultLocale)
    // The manifest link follows the locale, its text read in it, unless the app serves the manifest itself.
    const manifest = appServesManifest ? undefined : manifestPath(locale, seo, defaultLocale)
    const own = manifest === undefined ? extra : extra.map(tag => isOwnManifest(tag) ? { ...tag, props: { ...tag.props, href: manifest } } : tag)
    const tags: HeadTag[] = social ? [...own, meta('property', 'og:type', 'website')] : [...own]
    const name = text(seo.name)
    const description = text(seo.description)
    const image = text(seo.image)
    const imageAlt = text(seo.imageAlt)
    const ogLocale = text(seo.locale)

    if (name !== undefined)
      tags.push({ tag: 'title', props: { children: name } }, meta('property', 'og:site_name', name))

    if (description !== undefined)
      tags.push(meta('name', 'description', description))

    if (image !== undefined)
      tags.push(meta('property', 'og:image', image))

    if (image !== undefined && imageAlt !== undefined)
      tags.push(meta('property', 'og:image:alt', imageAlt))

    if (seo.twitter !== undefined)
      tags.push(meta('name', 'twitter:site', seo.twitter))

    if (ogLocale !== undefined)
      tags.push(meta('property', 'og:locale', ogLocale))

    for (const data of seo.jsonLd ?? [])
      tags.push({ tag: 'script', props: { type: 'application/ld+json', children: jsonLd(data) } })

    keepHeadMarkup(tags)

    const made = { tags, titleTemplate: text(seo.titleTemplate) }

    built.set(key, made)

    return made
  }

  // An error page is no URL to point search engines at.
  return (url, status) => {
    const state = localeState()
    const { tags, titleTemplate } = tagsFor(state?.locale, state?.settings.defaultLocale)

    return {
      defaults: origin !== undefined && status === 200 ? [...tags, ...pageLinks(origin, url, trailingSlash)] : tags,
      titleTemplate,
      social: social ? { origin, sizeOf } : undefined,
    }
  }
}

// The page's canonical URL, and in a site of several locales its copy in each, `x-default` the default locale's.
function pageLinks(origin: string, url: URL, trailingSlash: TrailingSlash | undefined): HeadTag[] {
  const state = localeState()

  if (!state || state.implicit)
    return [{ tag: 'link', props: { rel: 'canonical', href: origin + slashedPath(url.pathname, trailingSlash) } }]

  const copies = localeCopies(state.settings, state.path)
  const absolute = (copy: LocaleCopy) => `${copy.host === undefined ? origin : `https://${copy.host}`}${slashedPath(copy.path, trailingSlash)}`
  const own = copies.find(copy => copy.locale === state.locale)!
  const fallback = copies.find(copy => copy.locale === state.settings.defaultLocale)!

  return [
    { tag: 'link', props: { rel: 'canonical', href: absolute(own) } },
    ...copies.map(copy => ({ tag: 'link', props: { rel: 'alternate', hreflang: copy.locale, href: absolute(copy) } })),
    { tag: 'link', props: { rel: 'alternate', hreflang: 'x-default', href: absolute(fallback) } },
  ]
}

// `https://example.com`, with nothing after the host: page paths are appended to it as they are.
export function siteOrigin(site: string): string {
  let url: URL | undefined

  try {
    url = new URL(site)
  }
  catch {}

  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/' || url.search !== '' || url.hash !== '')
    throw new KayError('config-invalid', `kay: site is the origin the site is public at, such as https://example.com, not ${JSON.stringify(site)}`)

  return url.origin
}

function meta(key: 'name' | 'property', name: string, content: string): HeadTag {
  return { tag: 'meta', props: { [key]: name, content } }
}

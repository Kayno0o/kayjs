import { withBase } from './base'
import { renderedSite } from './site'

// Schema.org structured data: `@type` names what it describes, every other property is the vocabulary's own.
export interface JsonLd {
  '@context'?: string | undefined
  '@type': string | string[]
  '@id'?: string | undefined
  [property: string]: unknown
}

const SCHEMA_ORG = 'https://schema.org'
const LESS_THAN = /</g

// The text of a `script(type="application/ld+json")`, in the schema.org context unless it names its own; several things go in one `@graph`. No `<` survives, so a value cannot end the script.
export function jsonLd(data: JsonLd | JsonLd[]): string {
  const document = Array.isArray(data) ? { '@context': SCHEMA_ORG, '@graph': data } : { '@context': SCHEMA_ORG, ...data }

  return JSON.stringify(document).replace(LESS_THAN, '\\u003c')
}

// An absolute URL of the site, `siteUrl('/contact')`: from `site` and `base` in kay.config.ts on the server, from the page's own origin in the browser.
export function siteUrl(path = '/'): string {
  if (typeof document !== 'undefined')
    return window.location.origin + withBase(path)

  const site = renderedSite()

  if (site === undefined)
    throw unsetSite('siteUrl()')

  // As the canonical links are, under `trailingSlash: 'always'`.
  return site.origin + (site.slashed && !path.endsWith('/') && !path.includes('?') && !path.includes('#') ? `${path}/` : path)
}

// The site's origin alone, `https://example.com`, without `base`: from `site` in kay.config.ts on the server, the page's own in the browser.
export function siteOrigin(): string {
  if (typeof document !== 'undefined')
    return window.location.origin

  const site = renderedSite()

  if (site === undefined)
    throw unsetSite('siteOrigin()')

  return new URL(site.origin).origin
}

function unsetSite(reader: string): Error {
  return new Error(`kay: ${reader} reads site in kay.config.ts, the origin the site is public at, which it does not set, nor SITE_URL`)
}

export interface Crumb {
  name: string
  // The page's path, as a link to it is written: `/services`.
  path: string
}

// A breadcrumb trail as search engines read it, home first, each page's URL made absolute by `siteUrl`: `jsonLd(breadcrumbList([{ name: 'Home', path: '/' }, { name: 'Services', path: '/services' }]))`.
export function breadcrumbList(trail: Crumb[]): JsonLd {
  return {
    '@type': 'BreadcrumbList',
    'itemListElement': trail.map((crumb, index) => ({ '@type': 'ListItem', 'position': index + 1, 'name': crumb.name, 'item': siteUrl(crumb.path) })),
  }
}

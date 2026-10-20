import type { TrailingSlash } from '../config'
import type { Redirects } from '../server/redirects'
import type { CheckDiagnostic } from './index'
import type { OtherPage, RenderedPage, SiteSeo } from './seo'
import { basePath } from '../server/base'
import { fillTarget } from '../server/redirects'
import { slashedPath } from '../server/routes'
import { configLocator } from './config-keys'
import { decode, headOf, lintReporter } from './seo'

// The host of a site that names none, so the pages and the links between them are compared on the same one.
const NO_HOST = 'kay.invalid'
const ANCHOR_HREF = /<a(?=\s)[^>]*?\shref=(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi
const PERCENT_ESCAPE = /%[0-9a-f]{2}/gi
const QUERY_OR_HASH = /[?#].*$/
const TRAILING_SLASH = /\/+$/

export interface SiteSeoConfig extends SiteSeo {
  base?: string | undefined
  redirects?: Redirects | undefined
  trailingSlash?: TrailingSlash | undefined
}

export interface SiteSeoOptions {
  // The file the redirects of the config are in, and its source to find each redirect's line.
  configFile: string
  configSource?: string | undefined
  exported?: boolean | undefined
  // Whether a page of the site renders per request, whose links the build never saw.
  unseen?: boolean | undefined
}

interface Redirect {
  // The segments of the old path, a `:name` or a final `*` standing for what a request gives.
  from: string[]
  to: string
}

interface Place {
  host: string
  path: string
}

interface Match {
  to: string
  // The target with what the path gave filled in.
  filled: string
}

// What the prerendered pages of a public site say about one another, which no single page's head shows: a canonical link to a page that is gone, alternates that do not point back, a page nothing links to and a redirect leading to another.
export function siteSeoLints(config: SiteSeoConfig, pages: RenderedPage[], others: OtherPage[], options: SiteSeoOptions): CheckDiagnostic[] {
  const found: CheckDiagnostic[] = []
  const report = lintReporter(config, options.exported ?? false, found)
  const siteHost = config.site === undefined ? NO_HOST : hostOf(config.site)
  const base = basePath(config.base)
  const redirects = redirectsOf(config.redirects)

  const hostOfPage = (page: Pick<RenderedPage, 'host'>) => page.host?.toLowerCase() ?? siteHost
  const label = (page: Pick<RenderedPage, 'host' | 'path'>) => page.host === undefined ? page.path : `${page.host}${page.path}`
  const pageKey = (page: Pick<RenderedPage, 'host' | 'path'>) => keyOf(hostOfPage(page), page.path)
  const located = new Map<string, Place | undefined>()
  // A link as the page writes it, to the host and path of the page it reaches; none for what is not a page of a site, a `mailto:` or an address elsewhere.
  const locate = (href: string, from: Pick<RenderedPage, 'host' | 'path'>): Place | undefined => {
    // A path from the root reads the same wherever it is written, and a menu repeats it on every page.
    const shared = href.startsWith('/') && !href.startsWith('//') ? `${hostOfPage(from)}${href}` : undefined

    if (shared !== undefined && located.has(shared))
      return located.get(shared)

    let place: Place | undefined

    try {
      // A relative link is read from the URL the browser holds the page at, which `trailingSlash` spells.
      const url = new URL(href, `https://${hostOfPage(from)}${slashedPath(from.path, config.trailingSlash)}`)

      if (url.protocol === 'https:' || url.protocol === 'http:')
        place = { host: url.host, path: plainPath(withoutBase(url.pathname, base)) }
    }
    catch {}

    if (shared !== undefined)
      located.set(shared, place)

    return place
  }
  const resolve = (href: string, from: Pick<RenderedPage, 'host' | 'path'>): string | undefined => {
    const place = locate(href, from)

    return place && `${place.host}${place.path}`
  }

  const rendered = new Map(pages.map(page => [pageKey(page), page]))
  const elsewhere = new Map(others.map(page => [pageKey(page), page]))
  const hosts = new Set([siteHost, ...pages.map(hostOfPage), ...others.map(hostOfPage)])
  // Where a path leads when the config, or a page the build rendered as a redirect, sends it elsewhere.
  const redirectAt = (host: string, path: string): Match | undefined => {
    const page = elsewhere.get(keyOf(host, path))

    if (page !== undefined && page.status >= 300 && page.status < 400 && page.location !== undefined)
      return { to: page.location, filled: page.location }

    return matchRedirect(redirects, path)
  }
  const answered = (status: number, location: string | undefined) => status >= 300 && status < 400 && location !== undefined ? `redirects to \`${location}\`` : `answers ${status}`
  // Why the page a key names cannot be one a canonical link points at, when the build can tell.
  const gone = (key: string): { label: string, what: string, help: string } | undefined => {
    const page = elsewhere.get(key)

    if (page !== undefined)
      return { label: label(page), what: answered(page.status, page.location), help: page.location === undefined ? 'point it at a page that answers 200' : `point it at \`${page.location}\`, where the page is now` }

    const host = [...hosts].find(known => key.startsWith(known) && key[known.length] === '/')

    if (host === undefined)
      return undefined

    const path = key.slice(host.length)
    const moved = matchRedirect(redirects, path)

    return moved === undefined ? undefined : { label: host === siteHost ? path : `${host}${path}`, what: `redirects to \`${moved.filled}\``, help: `point it at \`${moved.filled}\`, where the page is now` }
  }

  for (const page of pages) {
    const canonical = headOf(page).canonical
    const key = canonical === undefined ? undefined : resolve(canonical, page)

    if (key === undefined || key === pageKey(page) || rendered.has(key))
      continue

    const target = gone(key)

    if (target !== undefined)
      report('broken-canonical', { file: page.file, line: 1, column: 1, message: `The canonical link of \`${label(page)}\` points at \`${target.label}\`, which ${target.what}`, note: 'search engines drop a canonical link to a page they cannot index, and may index the page itself in its place', help: target.help })
  }

  // Told once for a pair, whichever alternate of the page names the other.
  const told = new Set<string>()

  for (const page of pages) {
    const head = headOf(page)

    if (head.noindex || page.noindex)
      continue

    for (const alternate of head.alternates) {
      const key = resolve(alternate.href, page)

      if (key === undefined || key === pageKey(page))
        continue

      const target = rendered.get(key)

      if (target === undefined) {
        const missing = elsewhere.get(key)

        if (missing !== undefined)
          report('one-way-hreflang', { file: page.file, line: 1, column: 1, message: `\`${label(page)}\` lists \`${label(missing)}\` as its \`${alternate.hreflang}\` alternate, which ${answered(missing.status, missing.location)}`, help: 'point the alternate at a page that answers 200, or drop it' })

        continue
      }

      const targetHead = headOf(target)
      const pair = `${key}\n${pageKey(page)}`

      if (targetHead.noindex || target.noindex || told.has(pair))
        continue

      if (!targetHead.alternates.some(back => resolve(back.href, target) === pageKey(page))) {
        told.add(pair)
        report('one-way-hreflang', { file: target.file, line: 1, column: 1, message: `\`${label(target)}\` has no alternate pointing back at \`${label(page)}\`, which lists it as its \`${alternate.hreflang}\` alternate`, note: 'search engines ignore alternates that are not confirmed from both pages', help: `list \`${label(page)}\` as an alternate of \`${label(target)}\` too, in its head` })
      }
    }
  }

  const locateConfig = configLocator(options.configSource)
  const chain = (from: string, file: string, to: string, host: string, at = { line: 1, column: 1 }) => {
    if (!to.startsWith('/') || to.startsWith('//'))
      return

    const path = to.replace(QUERY_OR_HASH, '')
    const next = redirectAt(host, plainPath(path))

    if (next !== undefined)
      report('redirect-chain', { file, ...at, message: `The redirect from \`${from}\` goes to \`${path}\`, which redirects to \`${next.filled}\``, note: 'every hop costs a request, and crawlers give up on a long chain', help: `send \`${from}\` to \`${next.filled}\` directly` })
  }

  for (const [from, target] of Object.entries(config.redirects ?? {}))
    chain(from, options.configFile, typeof target === 'string' ? target : target.to, siteHost, locateConfig(['redirects', from]))

  for (const page of others) {
    const place = page.status >= 300 && page.status < 400 && page.location !== undefined ? locate(page.location, page) : undefined

    if (place?.host === hostOfPage(page))
      chain(label(page), page.file, place.path, place.host)
  }

  // Without a `site` there is no sitemap to know of, a server reading its origin when it boots; a page rendered per request may link to anything.
  const lost = config.site === undefined || options.unseen === true ? [] : pages.filter(page => page.listed === false && page.guarded !== true && !page.noindex && !isEntry(page) && !headOf(page).noindex)

  if (lost.length > 0) {
    const linked = new Set<string>()

    for (const page of pages) {
      const own = pageKey(page)

      for (const match of page.html.matchAll(ANCHOR_HREF)) {
        const href = match[1] ?? match[2] ?? match[3]!
        const key = resolve(href.includes('&') ? decode(href) : href, page)

        if (key !== undefined && key !== own)
          linked.add(key)
      }
    }

    for (const page of lost) {
      if (!linked.has(pageKey(page)))
        report('orphan-page', { file: page.file, line: 1, column: 1, message: `\`${label(page)}\` has no link to it and is not in the sitemap`, note: 'a crawler finds a page by a link or the sitemap', help: 'link it from a page that is indexed, or list it with `sitemap` in its `page`' })
    }
  }

  return found
}

// A page a crawler starts from: the site's root, or a locale's.
function isEntry(page: RenderedPage): boolean {
  return page.path === '/' || (page.locale !== undefined && page.path === `/${page.locale}`)
}

function keyOf(host: string, path: string): string {
  return `${host}${plainPath(path)}`
}

function hostOf(site: string): string {
  try {
    return new URL(site).host.toLowerCase()
  }
  catch {
    return NO_HOST
  }
}

function withoutBase(path: string, base: string): string {
  return base !== '' && (path === base || path.startsWith(`${base}/`)) ? path.slice(base.length) || '/' : path
}

// The path as a URL spells it, without a trailing slash and without what follows `?` or `#`.
function plainPath(path: string): string {
  let spelled = path

  try {
    spelled = new URL(path, 'https://kay.invalid').pathname
  }
  catch {}

  const upper = spelled.replace(PERCENT_ESCAPE, escape => escape.toUpperCase())

  return upper.length > 1 ? upper.replace(TRAILING_SLASH, '') || '/' : upper
}

function redirectsOf(redirects: Redirects | undefined): Redirect[] {
  return Object.entries(redirects ?? {}).map(([from, target]) => ({ from: segmentsOf(from), to: typeof target === 'string' ? target : target.to }))
}

function segmentsOf(path: string): string[] {
  const plain = plainPath(path)

  return plain === '/' ? [] : plain.split('/').slice(1)
}

// The first redirect whose old path covers `path`. A `:param` of the old path or its final `*` covers anything, and a `:param` or `*` in `path` itself, a target not yet filled, only those.
function matchRedirect(redirects: Redirect[], path: string): Match | undefined {
  const segments = segmentsOf(path)

  for (const { from, to } of redirects) {
    const params = new Map<string, string>()
    let rest = ''
    let covers = true

    for (const [index, part] of from.entries()) {
      const seen = segments[index]

      // A catch-all covers what follows its directory, never the directory alone.
      if (part === '*' && index === from.length - 1) {
        covers = seen !== undefined
        rest = segments.slice(index).join('/')

        break
      }

      if (seen === undefined || (part.startsWith(':') ? false : part !== seen)) {
        covers = false

        break
      }

      if (part.startsWith(':'))
        params.set(part.slice(1), seen)
    }

    if (covers && (segments.length === from.length || from.at(-1) === '*'))
      return { to, filled: fillTarget(to, name => params.get(name) ?? `:${name}`, rest) }
  }

  return undefined
}

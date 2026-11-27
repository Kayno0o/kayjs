// @kayjs/seo — SEO metadata, titleTemplate, JSON-LD, sitemap.xml, redirects, manifest, favicon, and self-hosted fonts.
// Built strictly on the public KayPlugin API (server, build, transformHtml).

import type { Html } from '@kayjs/kay'
import type { ActiveI18nConfig, BuildPluginContext, DocumentHeadContext, FinalizeBuildContext, KayPlugin, ServerPluginAPI } from '@kayjs/kay/config'
import type { RequestContext } from '@kayjs/kay/server'
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { definePlugin, I18N_CONFIG_SERVICE } from '@kayjs/kay/config'
import { escAttr, escJson, raw } from '@kayjs/kay/server'

export interface FontEntry {
  family: string
  /** Local relative path or package specifier (e.g. '@fontsource/inter/files/inter-latin-400-normal.woff2'). */
  src: string
  weight?: number | string | undefined
  style?: 'normal' | 'italic' | undefined
  display?: 'swap' | 'optional' | 'fallback' | 'block' | undefined
  preload?: boolean | undefined
}

export interface ManifestOptions {
  name?: string | undefined
  shortName?: string | undefined
  description?: string | undefined
  themeColor?: string | undefined
  backgroundColor?: string | undefined
  display?: 'standalone' | 'minimal-ui' | 'fullscreen' | 'browser' | undefined
  startUrl?: string | undefined
}

export type RedirectTarget = string | { to: string, status?: 301 | 302 | 307 | 308 | undefined }

export interface SeoPluginOptions {
  site?: string | undefined
  name?: string | undefined
  titleTemplate?: string | undefined
  description?: string | Record<string, string> | undefined
  image?: string | undefined
  imageAlt?: string | undefined
  locale?: string | undefined
  jsonLd?: Record<string, unknown>[] | undefined
  sitemap?: boolean | undefined
  sitemapExclude?: string[] | undefined
  extraUrls?: (() => string[]) | undefined
  redirects?: Record<string, RedirectTarget> | undefined
  favicon?: string | string[] | undefined
  manifest?: ManifestOptions | undefined
  fonts?: FontEntry[] | undefined
}

const JS_SCANNER = new Bun.Transpiler({ loader: 'js' })
const CANONICAL_LINK_RE = /<link rel="canonical" href="[^"]*">/

function serializeJsonLd(schema: Record<string, unknown>): string {
  const payload = '@context' in schema ? schema : { '@context': 'https://schema.org', ...schema }
  return `<script type="application/ld+json">${escJson(JSON.stringify(payload))}</script>`
}

/** Render a page-specific JSON-LD script inside `<Head>{jsonLd({ ... })}</Head>`. */
export function jsonLd(schema: Record<string, unknown>): Html {
  return raw(serializeJsonLd(schema))
}

function resolveFileOrPkg(root: string, spec: string): string | undefined {
  const local = resolve(root, spec)
  if (existsSync(local))
    return local
  try {
    return Bun.resolveSync(spec, root)
  }
  catch {
    return undefined
  }
}

function normalizePathname(pathname: string): string {
  const withSlash = pathname.startsWith('/') ? pathname : `/${pathname}`
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') || '/' : withSlash
}

function stripLocaleFromPath(pathname: string, i18n: ActiveI18nConfig): { locale: string, hasPrefix: boolean, basePath: string } {
  const normalized = normalizePathname(pathname)
  const parts = normalized.split('/')
  const first = parts[1]
  if (first !== undefined && i18n.locales.includes(first)) {
    const rest = normalizePathname(`/${parts.slice(2).join('/')}`)
    return { locale: first, hasPrefix: true, basePath: rest }
  }
  return { locale: i18n.defaultLocale, hasPrefix: false, basePath: normalized }
}

function localizeSitemapPath(basePath: string, locale: string, i18n: ActiveI18nConfig): string {
  const clean = normalizePathname(basePath)
  if (locale === i18n.defaultLocale && !i18n.prefixDefault)
    return clean
  return clean === '/' ? `/${locale}` : `/${locale}${clean}`
}

function localizeRedirectTarget(to: string, locale: string, i18n: ActiveI18nConfig): string {
  if (!to.startsWith('/') || to.startsWith('//'))
    return to
  const cut = to.search(/[?#]/)
  const pathname = cut === -1 ? to : to.slice(0, cut)
  const suffix = cut === -1 ? '' : to.slice(cut)
  const stripped = stripLocaleFromPath(pathname, i18n)
  if (stripped.hasPrefix)
    return to
  return `${localizeSitemapPath(stripped.basePath, locale, i18n)}${suffix}`
}

function isErrorLikePath(pathname: string, i18n: ActiveI18nConfig | undefined): boolean {
  const base = i18n !== undefined ? stripLocaleFromPath(pathname, i18n).basePath : normalizePathname(pathname)
  return base === '/404' || base === '/500' || base === '/__kay_404__'
}

function isApiPath(pathname: string): boolean {
  const norm = normalizePathname(pathname)
  return norm === '/api' || norm.startsWith('/api/')
}

function isApiRouteFile(outDir: string, relFile: string): boolean {
  const abs = join(outDir, relFile)
  if (!existsSync(abs))
    return false
  try {
    const { exports } = JS_SCANNER.scan(readFileSync(abs, 'utf8'))
    return !exports.includes('default') || exports.includes('GET')
  }
  catch {
    return false
  }
}

function readPngSize(bytes: Uint8Array): { width: number, height: number } | undefined {
  if (bytes.byteLength < 24)
    return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0) !== 0x89504E47 || view.getUint32(4) !== 0x0D0A1A0A)
    return undefined
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

function emitFavicons(ctx: BuildPluginContext, favicon: string | string[]): void {
  const favicons = Array.isArray(favicon) ? favicon : [favicon]
  const resolved: Array<{ abs: string, ext: string, bytes: Uint8Array }> = []
  const extCounts = new Map<string, number>()
  for (const fav of favicons) {
    const abs = resolveFileOrPkg(ctx.root, fav)
    if (abs === undefined)
      continue
    const ext = extname(abs).toLowerCase()
    const key = ext === '.svg' ? '.svg' : ext === '.png' ? '.png' : '.ico'
    extCounts.set(key, (extCounts.get(key) ?? 0) + 1)
    resolved.push({ abs, ext: key, bytes: new Uint8Array(readFileSync(abs)) })
  }

  const usedNames = new Set<string>()
  for (const item of resolved) {
    const size = item.ext === '.png' ? readPngSize(item.bytes) : undefined
    let outName: string
    if ((extCounts.get(item.ext) ?? 0) === 1) {
      outName = `favicon${item.ext}`
    }
    else {
      const stem = basename(item.abs, extname(item.abs)).toLowerCase().replace(/[^a-z0-9-_]/g, '-') || 'favicon'
      const candidate = `${stem}${item.ext}`
      if (!usedNames.has(candidate)) {
        outName = candidate
      }
      else if (size !== undefined && !usedNames.has(`${stem}-${size.width}x${size.height}${item.ext}`)) {
        outName = `${stem}-${size.width}x${size.height}${item.ext}`
      }
      else {
        outName = `${stem}-${Bun.hash(item.bytes).toString(36).slice(0, 6)}${item.ext}`
      }
    }
    usedNames.add(outName)
    const href = ctx.emitPublic(outName, item.bytes)
    const type = item.ext === '.svg' ? 'image/svg+xml' : item.ext === '.png' ? 'image/png' : 'image/x-icon'
    const sizesAttr = size !== undefined ? ` sizes="${size.width}x${size.height}"` : ''
    ctx.addHead(`<link rel="icon" href="${escAttr(href)}" type="${type}"${sizesAttr}>`)
  }
}

function emitManifest(ctx: BuildPluginContext, options: SeoPluginOptions): void {
  const m = options.manifest
  if (m === undefined)
    return
  const defaultDesc = typeof options.description === 'string'
    ? options.description
    : (options.description ? Object.values(options.description)[0] : undefined)
  const body = JSON.stringify({
    name: m.name ?? options.name ?? '',
    short_name: m.shortName ?? m.name ?? options.name ?? '',
    description: m.description ?? defaultDesc,
    start_url: m.startUrl ?? '/',
    display: m.display ?? 'standalone',
    theme_color: m.themeColor,
    background_color: m.backgroundColor,
  }, null, 2)
  const href = ctx.emitPublic('manifest.webmanifest', body)
  ctx.addHead(`<link rel="manifest" href="${escAttr(href)}">`)
  if (m.themeColor)
    ctx.addHead(`<meta name="theme-color" content="${escAttr(m.themeColor)}">`)
}

function emitFonts(ctx: BuildPluginContext, fonts: FontEntry[]): void {
  const cssRules: string[] = []
  for (const font of fonts) {
    const abs = resolveFileOrPkg(ctx.root, font.src)
    if (abs === undefined)
      throw new Error(`@kayjs/seo: could not resolve font "${font.src}"`)
    const bytes = new Uint8Array(readFileSync(abs))
    const hash = Bun.hash(bytes).toString(36)
    const ext = extname(abs).toLowerCase() || '.woff2'
    const stem = basename(abs, ext).toLowerCase().replace(/[^a-z0-9-_]/g, '-')
    const url = ctx.emitAsset(`fonts/${stem}-${hash}${ext}`, bytes)
    const weight = font.weight ?? 400
    const style = font.style ?? 'normal'
    const display = font.display ?? 'swap'
    const format = ext === '.woff2' ? 'woff2' : ext === '.woff' ? 'woff' : 'truetype'
    cssRules.push(`@font-face{font-family:${JSON.stringify(font.family)};font-style:${style};font-weight:${weight};font-display:${display};src:url(${JSON.stringify(url)}) format(${JSON.stringify(format)});}`)
    if (font.preload !== false && ext === '.woff2')
      ctx.addHead(`<link rel="preload" href="${escAttr(url)}" as="font" type="font/woff2" crossorigin>`)
  }
  if (cssRules.length > 0) {
    const css = cssRules.join('\n')
    const cssHash = Bun.hash(css).toString(36)
    const cssUrl = ctx.emitAsset(`fonts-${cssHash}.css`, css)
    ctx.addStyle(cssUrl)
  }
}

function emitSitemap(
  ctx: FinalizeBuildContext,
  site: string,
  options: SeoPluginOptions,
  i18nCfg: ActiveI18nConfig | undefined,
): void {
  const excluded = new Set(options.sitemapExclude ?? [])
  const urls = new Set<string>()
  for (const r of ctx.routes) {
    if (isApiPath(r.path) || isErrorLikePath(r.path, i18nCfg) || isApiRouteFile(ctx.outDir, r.file))
      continue
    if (r.prerendered) {
      for (const u of Object.keys(r.prerendered)) {
        if (!excluded.has(u) && !isApiPath(u) && !isErrorLikePath(u, i18nCfg))
          urls.add(u)
      }
    }
    else if (!r.path.includes(':') && !r.path.includes('*')) {
      if (i18nCfg !== undefined && i18nCfg.locales.length > 0) {
        for (const loc of i18nCfg.locales) {
          const localized = localizeSitemapPath(r.path, loc, i18nCfg)
          if (!excluded.has(localized) && !excluded.has(r.path))
            urls.add(localized)
        }
      }
      else if (!excluded.has(r.path)) {
        urls.add(r.path)
      }
    }
  }
  if (options.extraUrls !== undefined) {
    for (const u of options.extraUrls()) {
      if (!excluded.has(u) && !isErrorLikePath(u, i18nCfg))
        urls.add(u)
    }
  }
  const sortedUrls = [...urls].sort()
  if (i18nCfg !== undefined && i18nCfg.locales.length > 0) {
    const localeOrder = new Map(i18nCfg.locales.map((l, idx) => [l, idx]))
    const byBase = new Map<string, Array<{ locale: string, path: string }>>()
    for (const u of sortedUrls) {
      const { locale, basePath } = stripLocaleFromPath(u, i18nCfg)
      let group = byBase.get(basePath)
      if (group === undefined) {
        group = []
        byBase.set(basePath, group)
      }
      if (!group.some(item => item.locale === locale))
        group.push({ locale, path: u })
    }
    for (const group of byBase.values())
      group.sort((a, b) => (localeOrder.get(a.locale) ?? 999) - (localeOrder.get(b.locale) ?? 999))

    const entries = sortedUrls.map((u) => {
      const { basePath } = stripLocaleFromPath(u, i18nCfg)
      const group = byBase.get(basePath) ?? []
      const alts = group
        .map(a => `<xhtml:link rel="alternate" hreflang="${escAttr(a.locale)}" href="${escAttr(`${site}${a.path === '/' ? '/' : a.path}`)}"/>`)
        .join('')
      return `  <url><loc>${escAttr(`${site}${u === '/' ? '/' : u}`)}</loc>${alts}</url>`
    }).join('\n')
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries}\n</urlset>\n`
    ctx.emitPublic('sitemap.xml', xml)
  }
  else {
    const entries = sortedUrls.map(u => `  <url><loc>${escAttr(`${site}${u === '/' ? '/' : u}`)}</loc></url>`).join('\n')
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`
    ctx.emitPublic('sitemap.xml', xml)
  }
}

function registerRedirects(
  api: ServerPluginAPI,
  redirects: Record<string, RedirectTarget>,
  i18nCfg: ActiveI18nConfig | undefined,
): void {
  const exactLocaleRules = new Map<string, { to: string, status: 301 | 302 | 307 | 308 }>()
  for (const [from, target] of Object.entries(redirects)) {
    const to = typeof target === 'string' ? target : target.to
    const status = typeof target === 'string' ? 301 : (target.status ?? 301)
    if (i18nCfg !== undefined && stripLocaleFromPath(from, i18nCfg).hasPrefix) {
      exactLocaleRules.set(normalizePathname(from), { to, status })
      continue
    }
    api.route('GET', from, (ctx) => {
      if (i18nCfg === undefined)
        return ctx.redirect(to, status)
      const locale = 'locale' in ctx.locals && typeof ctx.locals.locale === 'string'
        ? ctx.locals.locale
        : i18nCfg.defaultLocale
      return ctx.redirect(localizeRedirectTarget(to, locale, i18nCfg), status)
    })
  }
  if (exactLocaleRules.size > 0) {
    api.use((ctx, next) => {
      if (ctx.request.method === 'GET' || ctx.request.method === 'HEAD') {
        const hit = exactLocaleRules.get(normalizePathname(ctx.url.pathname))
        if (hit !== undefined)
          return ctx.redirect(hit.to, hit.status)
      }
      return next()
    })
  }
}

function resolveFallbackDescription(
  description: SeoPluginOptions['description'],
  ctx: RequestContext,
  i18nCfg: ActiveI18nConfig | undefined,
): string | undefined {
  if (typeof description === 'string')
    return description
  if (description === undefined)
    return undefined
  const loc = 'locale' in ctx.locals && typeof ctx.locals.locale === 'string' ? ctx.locals.locale : undefined
  const fallbackLoc = i18nCfg?.defaultLocale
  return (loc && description[loc]) ?? (fallbackLoc && description[fallbackLoc]) ?? Object.values(description)[0]
}

function applySeoHead(
  head: DocumentHeadContext,
  ctx: RequestContext,
  options: SeoPluginOptions,
  activeSite: string | undefined,
  activeI18n: ActiveI18nConfig | undefined,
  errorRequests: WeakSet<Request>,
  seoCanonicalRequests: WeakSet<Request>,
): void {
  if (options.titleTemplate || options.name) {
    if (head.title !== undefined) {
      if (options.titleTemplate && (!options.name || !head.title.includes(options.name))) {
        const safeTemplate = escAttr(options.titleTemplate)
        head.title = safeTemplate.replace('%s', () => head.title!)
      }
    }
    else if (options.name) {
      head.title = escAttr(options.name)
    }
  }

  const fallbackDesc = resolveFallbackDescription(options.description, ctx, activeI18n)
  if (fallbackDesc && !head.headHtml.includes('name="description"')) {
    const content = escAttr(fallbackDesc)
    head.add(`<meta name="description" content="${content}">`)
    if (!head.headHtml.includes('property="og:description"'))
      head.add(`<meta property="og:description" content="${content}">`)
  }

  if (options.image && !head.headHtml.includes('property="og:image"')) {
    const imgUrl = options.image.startsWith('http') || !activeSite
      ? options.image
      : `${activeSite}${options.image.startsWith('/') ? '' : '/'}${options.image}`
    head.add(`<meta property="og:image" content="${escAttr(imgUrl)}">`)
    if (!head.headHtml.includes('name="twitter:card"'))
      head.add('<meta name="twitter:card" content="summary_large_image">')
    if (options.imageAlt && !head.headHtml.includes('property="og:image:alt"'))
      head.add(`<meta property="og:image:alt" content="${escAttr(options.imageAlt)}">`)
  }

  if (activeSite && !head.headHtml.includes('rel="canonical"') && !errorRequests.has(ctx.request) && !isErrorLikePath(ctx.url.pathname, activeI18n)) {
    const canonical = escAttr(`${activeSite}${ctx.url.pathname}`)
    head.add(`<link rel="canonical" href="${canonical}">`)
    seoCanonicalRequests.add(ctx.request)
  }
}

export function seo(options: SeoPluginOptions = {}): KayPlugin {
  let activeSite = options.site?.replace(/\/$/, '')
  let activeI18n: ActiveI18nConfig | undefined
  const errorRequests = new WeakSet<Request>()
  const seoCanonicalRequests = new WeakSet<Request>()

  const resolveSite = (ctxSite?: string): string | undefined =>
    options.site?.replace(/\/$/, '') ?? ctxSite?.replace(/\/$/, '') ?? activeSite

  return definePlugin({
    name: '@kayjs/seo',
    after: ['@kayjs/i18n'],
    readsLocals: ['locale'],

    onError({ request }) {
      errorRequests.add(request)
    },

    server(api) {
      activeSite = resolveSite(api.site)
      activeI18n = api.inject<ActiveI18nConfig>(I18N_CONFIG_SERVICE)
      if (options.redirects !== undefined)
        registerRedirects(api, options.redirects, activeI18n)

      // Strip auto-injected canonical tag on 4xx/5xx fallback pages (e.g. _404.tsx / load() -> notFound()).
      api.use(async (ctx, next) => {
        const res = await next()
        if (res.status >= 400 && seoCanonicalRequests.has(ctx.request) && !res.headers.has('content-encoding') && (res.headers.get('content-type') ?? '').includes('text/html')) {
          const html = await res.text()
          const cleaned = html.replace(CANONICAL_LINK_RE, '')
          if (cleaned !== html) {
            const headers = new Headers(res.headers)
            headers.delete('content-length')
            return new Response(cleaned, { status: res.status, statusText: res.statusText, headers })
          }
        }
        return res
      }, { scope: 'dynamic' })
    },

    build(ctx) {
      activeSite = resolveSite(ctx.site)
      activeI18n = ctx.inject<ActiveI18nConfig>(I18N_CONFIG_SERVICE)

      if (options.name)
        ctx.addHead(`<meta property="og:site_name" content="${escAttr(options.name)}">`)
      if (options.locale)
        ctx.addHead(`<meta property="og:locale" content="${escAttr(options.locale)}">`)
      if (options.jsonLd) {
        for (const schema of options.jsonLd)
          ctx.addHead(serializeJsonLd(schema))
      }
      if (options.favicon)
        emitFavicons(ctx, options.favicon)
      emitManifest(ctx, options)
      if (options.fonts && options.fonts.length > 0)
        emitFonts(ctx, options.fonts)
    },

    afterPrerender(ctx) {
      const site = resolveSite(ctx.site)
      const i18nCfg = ctx.inject<ActiveI18nConfig>(I18N_CONFIG_SERVICE) ?? activeI18n
      if (site && options.sitemap !== false)
        emitSitemap(ctx, site, options, i18nCfg)
    },

    head(head, ctx) {
      applySeoHead(head, ctx, options, activeSite, activeI18n, errorRequests, seoCanonicalRequests)
    },
  })
}

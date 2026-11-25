// @kayjs/seo — SEO metadata, titleTemplate, JSON-LD, sitemap.xml, redirects, manifest, favicon, and self-hosted fonts.
// Built strictly on the public KayPlugin API (server, build, transformHtml).

import type { Html } from '@kayjs/kay'
import type { ActiveI18nConfig, KayPlugin } from '@kayjs/kay/server'
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { definePlugin, I18N_CONFIG_SERVICE } from '@kayjs/kay/server'
import { escAttr, raw } from '@kayjs/kay/ssr'

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

function serializeJsonLd(schema: Record<string, unknown>): string {
  const payload = '@context' in schema ? schema : { '@context': 'https://schema.org', ...schema }
  const safe = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `<script type="application/ld+json">${safe}</script>`
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

const TITLE_TAG_RE = /<title>([\s\S]*?)<\/title>/i

function descriptionTags(description: string): string {
  const content = escAttr(description)
  return `<meta name="description" content="${content}"><meta property="og:description" content="${content}">`
}

function stripLocaleFromPath(pathname: string, i18n: ActiveI18nConfig): { locale: string, basePath: string } {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`
  const parts = normalized.split('/')
  const first = parts[1]
  if (first !== undefined && i18n.locales.includes(first)) {
    const rest = `/${parts.slice(2).join('/')}`.replace(/\/+$/, '') || '/'
    return { locale: first, basePath: rest }
  }
  return { locale: i18n.defaultLocale, basePath: normalized === '/' ? '/' : normalized.replace(/\/+$/, '') || '/' }
}

function localizeSitemapPath(basePath: string, locale: string, i18n: ActiveI18nConfig): string {
  const clean = basePath === '/' ? '/' : basePath.replace(/\/+$/, '') || '/'
  if (locale === i18n.defaultLocale && !i18n.prefixDefault)
    return clean
  return clean === '/' ? `/${locale}` : `/${locale}${clean}`
}

export function seo(options: SeoPluginOptions = {}): KayPlugin {
  let activeSite = options.site?.replace(/\/$/, '')
  let activeI18n: ActiveI18nConfig | undefined

  const resolveSite = (ctxSite?: string): string | undefined =>
    options.site?.replace(/\/$/, '') ?? ctxSite?.replace(/\/$/, '') ?? activeSite

  return definePlugin({
    name: '@kayjs/seo',
    after: ['@kayjs/i18n'],
    readsLocals: ['locale'],

    server(api) {
      activeSite = resolveSite(api.site)
      activeI18n = api.inject<ActiveI18nConfig>(I18N_CONFIG_SERVICE)
      if (options.redirects !== undefined) {
        for (const [from, target] of Object.entries(options.redirects)) {
          const to = typeof target === 'string' ? target : target.to
          const status = typeof target === 'string' ? 301 : (target.status ?? 301)
          api.route('GET', from, ctx => ctx.redirect(to, status))
        }
      }
    },

    build(ctx) {
      activeSite = resolveSite(ctx.site)
      activeI18n = ctx.inject<ActiveI18nConfig>(I18N_CONFIG_SERVICE)
      const site = activeSite
      // 1. Default meta, OG, Twitter, and JSON-LD tags
      if (typeof options.description === 'string') {
        ctx.addHead(descriptionTags(options.description))
      }
      if (options.name)
        ctx.addHead(`<meta property="og:site_name" content="${escAttr(options.name)}">`)
      if (options.locale)
        ctx.addHead(`<meta property="og:locale" content="${escAttr(options.locale)}">`)
      if (options.image) {
        const imgUrl = options.image.startsWith('http') || !site ? options.image : `${site}${options.image.startsWith('/') ? '' : '/'}${options.image}`
        ctx.addHead(`<meta property="og:image" content="${escAttr(imgUrl)}">`)
        ctx.addHead(`<meta name="twitter:card" content="summary_large_image">`)
        if (options.imageAlt)
          ctx.addHead(`<meta property="og:image:alt" content="${escAttr(options.imageAlt)}">`)
      }
      if (options.jsonLd) {
        for (const schema of options.jsonLd)
          ctx.addHead(serializeJsonLd(schema))
      }

      // 2. Favicon(s)
      if (options.favicon) {
        const favicons = Array.isArray(options.favicon) ? options.favicon : [options.favicon]
        for (const fav of favicons) {
          const abs = resolveFileOrPkg(ctx.root, fav)
          if (abs !== undefined) {
            const ext = extname(abs).toLowerCase()
            const outName = ext === '.svg' ? 'favicon.svg' : ext === '.png' ? 'favicon.png' : 'favicon.ico'
            const href = ctx.emitPublic(outName, new Uint8Array(readFileSync(abs)))
            const type = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/x-icon'
            ctx.addHead(`<link rel="icon" href="${escAttr(href)}" type="${type}">`)
          }
        }
      }

      // 3. Web App Manifest
      if (options.manifest) {
        const m = options.manifest
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

      // 4. Self-hosted fonts (@fontsource or local .woff2) -> immutable assets + @font-face CSS + preload
      if (options.fonts && options.fonts.length > 0) {
        const cssRules: string[] = []
        for (const font of options.fonts) {
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
    },

    afterPrerender(ctx) {
      // 5. Sitemap XML (runs after Step 3 prerendering so dynamic `paths()` and @kayjs/i18n URLs are included)
      const site = resolveSite(ctx.site)
      const i18nCfg = ctx.inject<ActiveI18nConfig>(I18N_CONFIG_SERVICE) ?? activeI18n
      if (site && options.sitemap !== false) {
        const excluded = new Set(options.sitemapExclude ?? [])
        const urls = new Set<string>()
        for (const r of ctx.routes) {
          if (r.prerendered) {
            for (const u of Object.keys(r.prerendered)) {
              if (!excluded.has(u))
                urls.add(u)
            }
          }
          else if (!r.path.includes(':') && !r.path.includes('*') && !r.path.startsWith('/api/')) {
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
            if (!excluded.has(u))
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
    },

    transformHtml(html, ctx) {
      const headEnd = html.indexOf('</head>')
      if (headEnd === -1)
        return html
      let head = html.slice(0, headEnd)
      const rest = html.slice(headEnd)

      // Title template / default title (strictly inside <head>, never matching inline <svg><title> in <body>)
      if (options.titleTemplate || options.name) {
        const m = TITLE_TAG_RE.exec(head)
        if (m !== null) {
          const inner = m[1]!
          if (options.titleTemplate && (!options.name || !inner.includes(options.name))) {
            const safeTemplate = escAttr(options.titleTemplate)
            const formatted = safeTemplate.replace('%s', () => inner)
            head = head.replace(TITLE_TAG_RE, () => `<title>${formatted}</title>`)
          }
        }
        else if (options.name) {
          const defaultTitle = escAttr(options.name)
          head += `<title>${defaultTitle}</title>`
        }
      }

      // Localized fallback description when <head> didn't emit its own <meta name="description">
      if (options.description && typeof options.description === 'object' && !head.includes('name="description"')) {
        const loc = 'locale' in ctx.locals && typeof ctx.locals.locale === 'string' ? ctx.locals.locale : undefined
        const fallbackLoc = activeI18n?.defaultLocale
        const desc = (loc && options.description[loc]) ?? (fallbackLoc && options.description[fallbackLoc]) ?? Object.values(options.description)[0]
        if (desc)
          head += descriptionTags(desc)
      }

      // Canonical URL
      if (activeSite && !head.includes('rel="canonical"')) {
        const canonical = escAttr(`${activeSite}${ctx.url.pathname}`)
        head += `<link rel="canonical" href="${canonical}">`
      }

      return head + rest
    },
  })
}

// @kayjs/seo — SEO metadata, titleTemplate, JSON-LD, sitemap.xml, redirects, manifest, favicon, and self-hosted fonts.
// Built strictly on the public KayPlugin API (server, build, transformHtml).

import type { Html } from 'kay'
import type { KayPlugin } from 'kay/server'
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { escAttr, raw } from 'kay/ssr'

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
  description?: string | undefined
  image?: string | undefined
  imageAlt?: string | undefined
  locale?: string | undefined
  jsonLd?: Record<string, unknown>[] | undefined
  sitemap?: boolean | undefined
  sitemapExclude?: string[] | undefined
  redirects?: Record<string, RedirectTarget> | undefined
  favicon?: string | undefined
  manifest?: ManifestOptions | undefined
  fonts?: FontEntry[] | undefined
}

function serializeJsonLd(schema: Record<string, unknown>): string {
  const payload = '@context' in schema ? schema : { '@context': 'https://schema.org', ...schema }
  const safe = JSON.stringify(payload).replaceAll('</script', '<\\/script')
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

export function seo(options: SeoPluginOptions = {}): KayPlugin {
  const site = options.site?.replace(/\/$/, '')

  return {
    name: '@kayjs/seo',

    server(api) {
      if (options.redirects !== undefined) {
        for (const [from, target] of Object.entries(options.redirects)) {
          const to = typeof target === 'string' ? target : target.to
          const status = typeof target === 'string' ? 301 : (target.status ?? 301)
          api.route('GET', from, ctx => ctx.redirect(to, status))
        }
      }
    },

    build(ctx) {
      // 1. Default meta, OG, Twitter, and JSON-LD tags
      if (options.description) {
        ctx.addHead(`<meta name="description" content="${escAttr(options.description)}">`)
        ctx.addHead(`<meta property="og:description" content="${escAttr(options.description)}">`)
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

      // 2. Favicon
      if (options.favicon) {
        const abs = resolveFileOrPkg(ctx.root, options.favicon)
        if (abs !== undefined) {
          const ext = extname(abs).toLowerCase()
          const outName = ext === '.svg' ? 'favicon.svg' : ext === '.png' ? 'favicon.png' : 'favicon.ico'
          const href = ctx.emitPublic(outName, new Uint8Array(readFileSync(abs)))
          const type = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/x-icon'
          ctx.addHead(`<link rel="icon" href="${escAttr(href)}" type="${type}">`)
        }
      }

      // 3. Web App Manifest
      if (options.manifest) {
        const m = options.manifest
        const body = JSON.stringify({
          name: m.name ?? options.name ?? '',
          short_name: m.shortName ?? m.name ?? options.name ?? '',
          description: m.description ?? options.description,
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

      // 5. Sitemap XML
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
          else if (!r.path.includes(':') && !r.path.includes('*') && !r.path.startsWith('/api/') && !excluded.has(r.path)) {
            urls.add(r.path)
          }
        }
        const entries = [...urls].sort().map(u => `  <url><loc>${escAttr(`${site}${u === '/' ? '/' : u}`)}</loc></url>`).join('\n')
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`
        ctx.emitPublic('sitemap.xml', xml)
      }
    },

    transformHtml(html, ctx) {
      let out = html

      // Title template / default title
      if (options.titleTemplate || options.name) {
        const m = TITLE_TAG_RE.exec(out)
        if (m !== null) {
          const inner = m[1]!
          if (options.titleTemplate && (!options.name || !inner.includes(options.name))) {
            const formatted = options.titleTemplate.replace('%s', inner)
            out = out.replace(TITLE_TAG_RE, `<title>${formatted}</title>`)
          }
        }
        else if (options.name) {
          out = out.replace('</head>', `<title>${escAttr(options.name)}</title></head>`)
        }
      }

      // Canonical URL
      if (site && !out.includes('rel="canonical"')) {
        const canonical = `${site}${ctx.url.pathname}`
        out = out.replace('</head>', `<link rel="canonical" href="${escAttr(canonical)}"></head>`)
      }

      return out
    },
  }
}

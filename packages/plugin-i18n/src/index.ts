// @kayjs/i18n — opt-in locale routing, <html lang> & link rewriting, localized prerendering,
// hreflang alternates, Intl formatters, and CLI missing-key check.
// Implemented 100% through KayPlugin public hooks — zero i18n logic in @kay/core.

import type { KayPlugin } from 'kay/server'

export interface I18nOptions {
  locales: string[]
  defaultLocale: string
  messages?: Record<string, Record<string, string>> | undefined
  /** Prefix URLs for default locale too (default: false). */
  prefixDefault?: boolean | undefined
  /** Optional site origin (e.g. 'https://example.com') to auto-inject <link rel="alternate" hreflang="..."> tags. */
  site?: string | undefined
}

const INTERNAL_HREF_RE = /<a\b([^>]*?)\bhref="(\/[^"]*)"([^>]*)>/gi

function collapseLeadingSlashes(p: string): string {
  if (!p)
    return '/'
  const collapsed = p.replace(/^\/+/, '/')
  return collapsed.startsWith('/') ? collapsed : `/${collapsed}`
}

export function stripLocalePrefix(pathname: string, locales: readonly string[]): { locale: string | undefined, path: string } {
  const normalized = collapseLeadingSlashes(pathname)
  const parts = normalized.split('/')
  const first = parts[1]
  if (first !== undefined && locales.includes(first)) {
    const rest = collapseLeadingSlashes(`/${parts.slice(2).join('/')}`)
    return { locale: first, path: rest === '/' ? '/' : rest.replace(/\/+$/, '') || '/' }
  }
  return { locale: undefined, path: normalized }
}

export function localizePath(
  pathname: string,
  targetLocale: string,
  defaultLocale: string,
  locales: readonly string[],
  prefixDefault = false,
): string {
  const { path } = stripLocalePrefix(pathname, locales)
  const safePath = collapseLeadingSlashes(path)
  if (targetLocale === defaultLocale && !prefixDefault)
    return safePath
  return safePath === '/' ? `/${targetLocale}` : `/${targetLocale}${safePath}`
}

export function alternateLinks(
  pathname: string,
  options: { site?: string | undefined, locales: readonly string[], defaultLocale: string, prefixDefault?: boolean | undefined },
): Array<{ locale: string, href: string }> {
  const origin = options.site ? options.site.replace(/\/$/, '') : ''
  return options.locales.map(loc => ({
    locale: loc,
    href: `${origin}${localizePath(pathname, loc, options.defaultLocale, options.locales, options.prefixDefault)}`,
  }))
}

export function formatDate(
  value: Date | string | number,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'long' },
): string {
  const d = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat(locale, options).format(d)
}

export function formatNumber(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value)
}

export function i18n(options: I18nOptions): KayPlugin {
  const { locales, defaultLocale, messages = {}, prefixDefault = false, site } = options
  const localeSet = new Set(locales)

  function translate(locale: string, key: string): string {
    return messages[locale]?.[key] ?? messages[defaultLocale]?.[key] ?? key
  }

  return {
    name: '@kayjs/i18n',

    server(api) {
      // Rewrite /fr/about -> /about and attach locale + helpers onto ctx.locals
      api.rewrite((pathname, ctx) => {
        const { locale: matched, path } = stripLocalePrefix(pathname, locales)
        const active = matched ?? defaultLocale
        ctx.locals.locale = active
        ctx.locals.t = (key: string) => translate(active, key)
        ctx.locals.localize = (p: string, target = active) => localizePath(p, target, defaultLocale, locales, prefixDefault)
        ctx.locals.alternates = () => alternateLinks(path, { site, locales, defaultLocale, prefixDefault })
        return matched !== undefined ? path : undefined
      })

      api.route('GET', '/_i18n/locales', ctx =>
        ctx.json({ locales, defaultLocale, current: ctx.locals.locale ?? defaultLocale }))
    },

    prerenderPaths(paths) {
      const out: string[] = []
      const seen = new Set<string>()
      for (const raw of paths) {
        const { locale: already } = stripLocalePrefix(raw, locales)
        if (already !== undefined) {
          if (!seen.has(raw)) {
            seen.add(raw)
            out.push(raw)
          }
          continue
        }
        for (const loc of locales) {
          const localized = localizePath(raw, loc, defaultLocale, locales, prefixDefault)
          if (!seen.has(localized)) {
            seen.add(localized)
            out.push(localized)
          }
        }
      }
      return out
    },

    transformHtml(html, ctx) {
      const locale = String(ctx.locals.locale ?? defaultLocale)
      let out = html.replace(/<html\s+lang="[^"]*"/i, () => `<html lang="${locale}"`)

      if (site) {
        const { path } = stripLocalePrefix(ctx.url.pathname, locales)
        const links = alternateLinks(path, { site, locales, defaultLocale, prefixDefault })
        const tags = links.map(l => `<link rel="alternate" hreflang="${l.locale}" href="${l.href}">`).join('')
        if (tags && out.includes('</head>'))
          out = out.replace('</head>', () => `${tags}</head>`)
      }

      // Prefix internal <a href="/..."> links for non-default locales
      if (locale !== defaultLocale || prefixDefault) {
        out = out.replace(INTERNAL_HREF_RE, (match, before: string, href: string, after: string) => {
          if (before.includes('data-no-localize') || after.includes('data-no-localize'))
            return match
          if (href.startsWith('//') || href.startsWith('/_kay/') || href.startsWith('/_i18n/'))
            return match
          const seg = href.split('/')[1]
          if (seg !== undefined && localeSet.has(seg))
            return match
          const prefixed = href === '/' ? `/${locale}` : `/${locale}${href}`
          return `<a${before}href="${prefixed}"${after}>`
        })
      }

      return out
    },

    check(ctx) {
      const baseKeys = Object.keys(messages[defaultLocale] ?? {})
      for (const loc of locales) {
        if (loc === defaultLocale)
          continue
        const dict = messages[loc] ?? {}
        for (const key of baseKeys) {
          if (!(key in dict))
            ctx.error(`[i18n] ${loc}: missing translation key "${key}"`)
        }
      }
    },

    commands: {
      'i18n-check': () => {
        const baseKeys = Object.keys(messages[defaultLocale] ?? {})
        let missing = 0
        for (const loc of locales) {
          if (loc === defaultLocale)
            continue
          const dict = messages[loc] ?? {}
          for (const key of baseKeys) {
            if (!(key in dict)) {
              console.log(`[i18n] ${loc}: missing "${key}"`)
              missing++
            }
          }
        }
        if (missing === 0)
          console.log('[i18n] all locales complete')
      },
    },
  }
}

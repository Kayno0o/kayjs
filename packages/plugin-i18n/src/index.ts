// @kayjs/i18n — opt-in locale routing, <html lang> & link rewriting, localized prerendering,
// hreflang alternates, Intl formatters, and CLI missing-key check.
// Implemented 100% through KayPlugin public hooks — zero i18n logic in @kay/core.

import type { ActiveI18nConfig, KayPlugin } from '@kayjs/kay/config'
import { definePlugin, I18N_CONFIG_SERVICE } from '@kayjs/kay/config'
import { escAttr } from '@kayjs/kay/server'

declare module '@kayjs/kay/server' {
  interface KayLocals {
    locale?: string | undefined
    t?: ((key: string) => string) | undefined
    localize?: ((path: string, targetLocale?: string) => string) | undefined
    alternates?: (() => Array<{ locale: string, href: string }>) | undefined
  }
}

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
  const { locales, defaultLocale, messages = {}, prefixDefault = false } = options
  let activeSite = options.site?.replace(/\/$/, '')
  const localeSet = new Set(locales)
  const sharedConfig: ActiveI18nConfig = { locales, defaultLocale, prefixDefault }

  function translate(locale: string, key: string): string {
    return messages[locale]?.[key] ?? messages[defaultLocale]?.[key] ?? key
  }

  function* missingKeys(): Generator<{ locale: string, key: string }> {
    const baseKeys = Object.keys(messages[defaultLocale] ?? {})
    for (const locale of locales) {
      if (locale === defaultLocale)
        continue
      const dict = messages[locale] ?? {}
      for (const key of baseKeys) {
        if (!(key in dict))
          yield { locale, key }
      }
    }
  }

  return definePlugin({
    name: '@kayjs/i18n',
    enforce: 'pre',
    providesLocals: ['locale', 't', 'localize', 'alternates'],

    build(ctx) {
      if (options.site === undefined && ctx.site !== undefined)
        activeSite = ctx.site.replace(/\/$/, '')
      ctx.provide(I18N_CONFIG_SERVICE, sharedConfig)
    },

    server(api) {
      if (options.site === undefined && api.site !== undefined)
        activeSite = api.site.replace(/\/$/, '')
      api.provide(I18N_CONFIG_SERVICE, sharedConfig)

      // Rewrite /fr/about -> /about and attach locale + helpers onto ctx.locals
      api.rewrite((pathname, ctx) => {
        const { locale: matched, path } = stripLocalePrefix(pathname, locales)
        const active = matched ?? defaultLocale
        ctx.locals.locale = active
        ctx.locals.t = (key: string) => translate(active, key)
        ctx.locals.localize = (p: string, target = active) => localizePath(p, target, defaultLocale, locales, prefixDefault)
        ctx.locals.alternates = () => alternateLinks(path, { site: activeSite, locales, defaultLocale, prefixDefault })
        return matched !== undefined ? path : undefined
      })

      api.route('GET', '/_i18n/locales', ctx =>
        ctx.json({ locales, defaultLocale, current: ctx.locals.locale ?? defaultLocale }))
    },

    prerenderPaths(paths) {
      const out = new Set<string>()
      for (const raw of paths) {
        if (stripLocalePrefix(raw, locales).locale !== undefined) {
          out.add(raw)
          continue
        }
        for (const loc of locales)
          out.add(localizePath(raw, loc, defaultLocale, locales, prefixDefault))
      }
      return [...out]
    },

    head(head, ctx) {
      const locale = ctx.locals.locale ?? defaultLocale
      head.lang = locale

      if (activeSite) {
        const { path } = stripLocalePrefix(ctx.url.pathname, locales)
        const links = alternateLinks(path, { site: activeSite, locales, defaultLocale, prefixDefault })
        for (const l of links)
          head.add(`<link rel="alternate" hreflang="${escAttr(l.locale)}" href="${escAttr(l.href)}">`)
      }
    },

    transformHtml(html, ctx) {
      const locale = ctx.locals.locale ?? defaultLocale
      // Prefix internal <a href="/..."> links for non-default locales only
      if (locale === defaultLocale && !prefixDefault)
        return html
      return html.replace(INTERNAL_HREF_RE, (match, before: string, href: string, after: string) => {
        if (before.includes('data-no-localize') || after.includes('data-no-localize'))
          return match
        if (href.startsWith('//') || href.startsWith('/_kay/') || href.startsWith('/_i18n/'))
          return match
        const seg = href.split('/')[1]
        if (seg !== undefined && localeSet.has(seg))
          return match
        const prefixed = href === '/' ? `/${locale}` : `/${locale}${href}`
        return `<a${before}href="${escAttr(prefixed)}"${after}>`
      })
    },

    check(ctx) {
      for (const { locale, key } of missingKeys())
        ctx.error(`[i18n] ${locale}: missing translation key "${key}"`)
    },

    commands: {
      'i18n-check': () => {
        let missing = 0
        for (const { locale, key } of missingKeys()) {
          console.log(`[i18n] ${locale}: missing "${key}"`)
          missing++
        }
        if (missing === 0)
          console.log('[i18n] all locales complete')
      },
    },
  })
}

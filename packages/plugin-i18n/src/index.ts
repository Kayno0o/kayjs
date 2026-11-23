// @kayjs/i18n — opt-in locale routing, <html lang> & link rewriting, and CLI missing-key check.
// Implemented 100% through KayPlugin public hooks — zero i18n logic in @kay/core.

import type { KayPlugin } from 'kay/server'

export interface I18nOptions {
  locales: string[]
  defaultLocale: string
  messages?: Record<string, Record<string, string>> | undefined
  /** Prefix URLs for non-default locales (default: true). */
  prefixDefault?: boolean | undefined
}

const INTERNAL_HREF_RE = /<a\b([^>]*?)\bhref="(\/[^"]*)"([^>]*)>/gi

export function i18n(options: I18nOptions): KayPlugin {
  const { locales, defaultLocale, messages = {}, prefixDefault = false } = options
  const localeSet = new Set(locales)

  function translate(locale: string, key: string): string {
    return messages[locale]?.[key] ?? messages[defaultLocale]?.[key] ?? key
  }

  return {
    name: '@kayjs/i18n',

    server(api) {
      // Rewrite /fr/about -> /about and attach locale + translator onto ctx.locals
      api.rewrite((pathname, ctx) => {
        const parts = pathname.split('/')
        const first = parts[1]
        if (first !== undefined && localeSet.has(first)) {
          ctx.locals.locale = first
          ctx.locals.t = (key: string) => translate(first, key)
          const stripped = `/${parts.slice(2).join('/')}`
          return stripped === '/' ? '/' : stripped.replace(/\/$/, '') || '/'
        }
        ctx.locals.locale = defaultLocale
        ctx.locals.t = (key: string) => translate(defaultLocale, key)
        return undefined
      })

      // Expose metadata endpoint via api.route()
      api.route('GET', '/_i18n/locales', ctx =>
        ctx.json({ locales, defaultLocale, current: ctx.locals.locale ?? defaultLocale }))
    },

    transformHtml(html, ctx) {
      const locale = String(ctx.locals.locale ?? defaultLocale)
      let out = html.replace(/<html\s+lang="[^"]*"/i, `<html lang="${locale}"`)

      // Prefix internal <a href="/..."> links for non-default locales
      if (locale !== defaultLocale || prefixDefault) {
        out = out.replace(INTERNAL_HREF_RE, (match, before: string, href: string, after: string) => {
          if (before.includes('data-no-localize') || after.includes('data-no-localize'))
            return match
          if (href.startsWith('/_kay/') || href.startsWith('/_i18n/'))
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

# Locales

`i18n` in kay.config.ts serves every page in each locale, the default one unprefixed and the others under their prefix: `/about` and `/en/about`.

```ts
export default defineConfig({
  i18n: { locales: ['fr', 'en'], defaultLocale: 'fr' },
})
```

- `prefixDefault: true` puts the default locale under its prefix too, `/fr/about`; a path without one then redirects with a 307 to the visitor's locale: the one they last went to, kept in the `kay-locale` cookie once they follow a link of the site to it, then the best match of their browser's `Accept-Language`, then the default. Without it the URL alone decides.
- `domains: { fr: 'example.fr', en: 'example.com' }` serves each locale on its own host instead, with no prefixes; a host not listed serves the default locale, and every locale needs a host.
- A page cannot sit under a locale's prefix itself, `src/routes/en/`: kay serves every page there already. A root `[slug].kay` with no `index.kay` would take `/en` as a slug, so give the site an index page.
- `domains` and `prefixDefault` do not go together.
- `paths` names a page its own way in some locales, keyed by the pattern the page is served under: `{ '/about': { fr: '/a-propos' }, '/blog/:slug': { en: '/articles/:slug' } }`. A translation keeps the page's `:params`, an optional `:page?` and a final `*` alike, and may move them; the page is then served at `/a-propos` and `/en/articles/hello`, its untranslated path in that locale redirecting there with a 308, and with domains a host serves only its own locale's paths. `localize`, `alternate`, the `hreflang` links, the sitemap and `kay build --static` follow, and `kay check` checks links against the translated paths. A pattern no page serves, or a translation another page of the locale takes, stops the server.

Messages live in `src/messages/<locale>.ts`, one file per locale, `messages` in `i18n` naming another directory. Each exports its messages by default through `defineMessages`, nested as you like, a group never holding only keys named like plural forms (`one`, `other`...), which would read as one plural message; the default locale's file is the reference `kay check` holds the others to, and a key a locale lacks falls back to the default locale's text. A key no locale has, as a computed one may be, fails the render in development and tests, is logged in the browser in development, and shows as itself in production.

```ts
import { defineMessages } from 'kay/i18n'

export default defineMessages({
  nav: { home: 'Accueil' },
  greeting: 'Bonjour {name}',
  items: { zero: 'Aucun article', one: '{count} article', other: '{count} articles' },
})
```

`kay/i18n` works anywhere a request is served from: loads, templates, components, islands, actions and guards.

- `t('greeting', { name })` gives a message in the request's locale, its key and placeholders typed from the default locale's file. A number fills a placeholder formatted for the locale, `1 234` in French, and a date with `dateStyle: 'medium'`. An object of plural forms is picked by `count` through `Intl.PluralRules`, `zero` taking 0 whenever it is given. A key no locale has renders as itself.
- `formatNumber(value, options)` and `formatDate(value, options)` format through `Intl` for the request's locale, and so do `formatRelativeTime(date)`, a date relative to now in the largest unit it reaches, `3 days ago`, `yesterday` or `in 2 hours`, `formatRelativeTime(2, 'week')` in the unit given, and `formatList(['Ada', 'Grace'])`, `Ada and Grace`. In an island, give `formatRelativeTime` the moment it is relative to, `{ now }`, from the server, so the browser renders what the server did; `direction()` is `rtl` or `ltr`, for the request's locale or the one given; `locale()` names it, as do `ctx.locale` in pages and guards and an action's `ctx.locale`.
- `localize('/about')` is that path in the request's locale, or in the one given as second argument, checked like any link; `alternate('en')` is the page being rendered in another locale, for a language switcher. With domains, a locale on another host gives its absolute URL.
- An island gets only the messages it uses: those it looks up while rendering on the server and the keys its own source passes `t()` as they are written. A key built at runtime, or looked up only in a module the island imports, reaches the browser only if the server render used it.
- An action runs in the locale of the page it was sent from, read off its `Referer`, then the cookie and the browser's languages.

The page's `<html lang>` is its locale, with `dir="rtl"` for one written right to left, such as Arabic, Hebrew, Persian or Urdu, so the page lays itself out that way and CSS logical properties, `margin-inline-start`, follow. With `site`, every page links its copy in each locale, `<link rel="alternate" hreflang>`, `x-default` being the default locale's, its canonical URL is its own locale's, and the sitemap lists every copy with the others as `xhtml:link` alternates. `kay build` prerenders a page once per locale.

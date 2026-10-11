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
- `paths` names a page its own way in some locales, keyed by the pattern the page is served under: `{ '/about': { fr: '/a-propos' }, '/blog/:slug': { en: '/articles/:slug' } }`. A translation keeps the page's `:params`, an optional `:page?` and a final `*` alike, and may move them; the page is then served at `/a-propos` and `/en/articles/hello`, its untranslated path in that locale redirecting there with a 308, unless a public file, an endpoint, a redirect, an API route or a feed serves it, and with domains a host serves only its own locale's paths. `localize`, `alternate`, the `hreflang` links, the sitemap and `kay build --static` follow, and `kay check` checks links against the translated paths. A pattern no page serves, or a translation another page of the locale takes, stops the server.

Messages live in `src/messages/<locale>.ts`, one file per locale, `messages` in `i18n` naming another directory. Each exports its messages by default through `defineMessages`, nested as you like, a group never holding only keys named like plural forms (`one`, `other`...), which would read as one plural message; the default locale's file is the reference `kay check` holds the others to, and a key a locale lacks falls back to the default locale's text. A key no locale has, as a computed one may be, fails the render in development and tests, is logged in the browser in development, and shows as itself in production.

```ts
import { defineMessages } from 'kay/i18n'

export default defineMessages({
  nav: { home: 'Accueil' },
  greeting: 'Bonjour {name}',
  items: {
    zero: 'Aucun article',
    one: '{count} article',
    other: '{count} articles',
  },
})
```

A library listed in `extensions` can bring catalogs of its own, `<locale>.ts` each in the directory its `messages` names (see [Extensions](components.md#extensions)): every locale reads the library's messages with the app's laid over them key by key, so `auth: { title: 'Connexion' }` in `src/messages/fr.ts` replaces that one text of the library and keeps the rest. `t()` types the keys of both, and `kay check` holds each locale to the default one's keys, the library's included, so a locale the library does not translate is the app's to fill. The app needs no file of its own for a locale the library translates.

Without `i18n`, a site is in its one language, its `lang` (`en` without one): `t()` reads its libraries' catalogs for it, with the app's `src/messages/<lang>.ts` laid over them when it has one, and `kay check` types the keys of both. `locale()` is that language, `localize()` gives a path back as written, and no page gets `hreflang` links, so a library's pages read their texts in any app.

`t`, `locale`, `direction`, `localize`, `alternate`, `formatNumber`, `formatDate`, `formatRelativeTime`, `relativeTime` and `formatList` come from `kay/i18n`, which works anywhere a request is served from: loads, templates, components, islands, actions and guards, and in `renderToString` outside one, in the site's default locale or the one its `locale` option names (see rendering).

- `t('greeting', { name })`, which a template, a fence or an island reads with no import unless the file names its own `t`, gives a message in the request's locale, its key and placeholders typed from the default locale's file. A number fills a placeholder formatted for the locale, `1 234` in French, and a date with `dateStyle: 'medium'`. An object of plural forms is picked by `count` through `Intl.PluralRules`, `zero` taking 0 whenever it is given. A key no locale has renders as itself.
- `const ago = relativeTime(() => post.date)`, its options `Intl.RelativeTimeFormat`'s, is a memo of that date relative to now, read as `{ago}` in the template, that goes on ticking: every second under a minute away, every minute under an hour, every hour past that, until the island ends. The server renders it relative to the moment the page is rendered at, which it writes into the page, and the island's first render in the browser reads that moment too, so hydrating changes nothing; it then moves to the browser's clock. Using it makes the component an island.
- `T` renders a message holding markup, such as a link mid-sentence: see [Messages holding markup](#messages-holding-markup).
- `formatNumber(value, options)` and `formatDate(value, options)` format through `Intl` for the request's locale, and so do `formatRelativeTime(date)`, a date relative to now in the largest unit it reaches, `3 days ago`, `yesterday` or `in 2 hours`, `formatRelativeTime(2, 'week')` in the unit given, and `formatList(['Ada', 'Grace'])`, `Ada and Grace`. In an island, give `formatRelativeTime` the moment it is relative to, `{ now }`, from the server, so the browser renders what the server did, or use `relativeTime`; `direction()` is `rtl` or `ltr`, for the request's locale or the one given; `locale()` names it, as do `ctx.locale` in pages and guards and an action's `ctx.locale`.
- A link written as the default locale names a page, `a(href="/about")`, goes to the page's locale's copy as it renders: `/en/about` on an English page, translated by `paths`, on the locale's host with `domains`. So do links to a localized collection's feed, the links of Markdown entries, and those an island renders in the browser, so converting a site needs no change to its links. A link carrying `hreflang` stays as written, as a language switcher's must: `a(href={alternate('fr')} hreflang="fr")`. So does one already under a locale's prefix, one to a file a param would take (`/blog/cover.png`), and one to no page, such as an API route or a public file.
- `localize('/about')` is that path in the request's locale, or in the one given as second argument, checked like any link, for a path that is no `a`'s href: a redirect, a `fetch`, a URL to share. `alternate('en')` is the page being rendered in another locale, for a language switcher. With domains, a locale on another host gives its absolute URL.
- An island gets only the messages it uses: those it looks up while rendering on the server and the keys its own source passes `t()`, or `T` as `key`, as they are written. A key built at runtime, or looked up only in a module the island imports, reaches the browser only if the server render used it.
- A content collection with `localized: true` keeps one folder per locale, `src/content/posts/en/hello.md`, and reads the request's locale's entries, the default locale's standing in; see content.
- An action runs in the locale of the page it was sent from, the one its `ctx.params` are read off (see actions), then the cookie and the browser's languages.

The page's `<html lang>` is its locale, with `dir="rtl"` for one written right to left, such as Arabic, Hebrew, Persian or Urdu, so the page lays itself out that way and CSS logical properties, `margin-inline-start`, follow. With `site`, every page links its copy in each locale, `<link rel="alternate" hreflang>`, `x-default` being the default locale's, its canonical URL is its own locale's, and the sitemap lists every copy with the others as `xhtml:link` alternates. `kay build` prerenders a page once per locale.

## Messages holding markup

`T` from `kay/i18n` renders a message whose tags are filled by the blocks of their names, `intro: 'Read <about>our story</about>, {name}.'` through:

```kay
--- server
import { T } from 'kay/i18n'
---
T(key="intro" name="Ada")
  @about(text)
    a(href="/about") {text}
```

- Each block gets its tag's text, placeholders filled; the text inside a tag and out is escaped, a value holding `<b>` included.
- `kay check` types the key, the placeholders as props and one block per tag of the default locale's message, a tag without its block or a block for no tag being an error, and holds every locale to the default one's tags.
- Tags do not nest, and a plural's `count` goes as a prop like any placeholder. In an island, `T` renders again when a placeholder changes.
- `t()` gives such a message with its tags as written.

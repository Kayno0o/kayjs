# Locales

## Common tasks

### Serve a site in several locales

`i18n` in kay.config.ts serves every page in each locale, the default one unprefixed and the others under their prefix: `/about` and `/en/about`:

```ts
export default defineConfig({
  i18n: { locales: ['fr', 'en'], defaultLocale: 'fr' },
})
```

### Serve each locale on its own host

`domains` replaces the prefixes with a host per locale:

```ts
export default defineConfig({
  i18n: {
    locales: ['fr', 'en'],
    defaultLocale: 'fr',
    domains: { fr: 'example.fr', en: 'example.com' },
  },
})
```

### Name a page its own way in a locale

`paths` is keyed by the pattern the page is served under, so `/about` is served at `/a-propos` in French and `/blog/:slug` at `/en/articles/hello` in English:

```ts
export default defineConfig({
  i18n: {
    locales: ['fr', 'en'],
    defaultLocale: 'fr',
    paths: { '/about': { fr: '/a-propos' }, '/blog/:slug': { en: '/articles/:slug' } },
  },
})
```

### Write the messages of a locale

One file per locale in `src/messages/<locale>.ts`, exporting its messages by default through `defineMessages`, with plural forms picked by `count`:

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

### Show a message

`t` needs no import in a template, a fence or an island, and gives the message in the request's locale:

```kay
---
const { name, count } = props<{ name: string, count: number }>()
---
nav
  a(href="/") {t('nav.home')}
p {t('greeting', { name })}
p {t('items', { count })}
```

### Put a link in the middle of a message

`T` renders a message whose tags are filled by the blocks of their names, `intro: 'Read <about>our story</about>, {name}.'`:

```kay
--- server
import { T } from 'kay/i18n'
---
T(key="intro" name="Ada")
  @about(text)
    a(href="/about") {text}
```

### Switch language

`alternate` gives the page being rendered in another locale, and a link carrying `hreflang` stays as written:

```kay
--- server
import { alternate } from 'kay/i18n'
---
a(href={alternate('fr')} hreflang="fr") Français
a(href={alternate('en')} hreflang="en") English
```

`locales()` lists every locale of `i18n`, typed as the app's `Locale`, and `localeName(code)` names one in its own language, so a switcher hard-codes neither:

```kay
--- server
import { alternate, localeName, locales } from 'kay/i18n'
---
nav
  for code of locales()
    a(href={alternate(code)} hreflang={code}) {localeName(code)}
```

### Format a number, a date or a list

These format through `Intl` for the request's locale:

```kay
--- server
import { formatDate, formatList, formatNumber, formatRelativeTime } from 'kay/i18n'
---
p {formatNumber(1234.5)}
p {formatDate(new Date(), { dateStyle: 'long' })}
p {formatRelativeTime(new Date(Date.now() - 3 * 86_400_000))}
p {formatList(['Ada', 'Grace'])}
```

### Show a date relative to now that keeps ticking

`relativeTime` is a memo of that date relative to now, read by calling it, and makes the component an island:

```kay
---
import { relativeTime } from 'kay/i18n'

const { date } = props<{ date: Date }>()
const ago = relativeTime(() => date)
---
time {ago()}
```

### Link to a path that is no link

`localize` gives a path in the request's locale, for a redirect, a `fetch` or a URL to share:

```kay
--- server
import { localize } from 'kay/i18n'

const target = localize('/about')
---
p {target}
```

## Reference

### Configuring locales

- `i18n` in kay.config.ts serves every page in each locale, the default one unprefixed and the others under their prefix: `/about` and `/en/about`.
- `prefixDefault: true` puts the default locale under its prefix too, `/fr/about`; a path without one then redirects with a 307 to the visitor's locale: the one they last went to, kept in the `kay_locale` cookie once they follow a link of the site to it, then the best match of their browser's `Accept-Language`, then the default.
- Without `prefixDefault` the URL alone decides.
- `domains: { fr: 'example.fr', en: 'example.com' }` serves each locale on its own host instead, with no prefixes; a host not listed serves the default locale, and every locale needs a host.
- `domains` and `prefixDefault` do not go together.
- A page cannot sit under a locale's prefix itself, `src/routes/en/`: kay serves every page there already.
- A root `[slug].kay` with no `index.kay` would take `/en` as a slug, so give the site an index page.
- `paths` names a page its own way in some locales, keyed by the pattern the page is served under: `{ '/about': { fr: '/a-propos' }, '/blog/:slug': { en: '/articles/:slug' } }`.
- A translation keeps the page's `:params`, an optional `:page?` and a final `*` alike, and may move them.
- The page is then served at `/a-propos` and `/en/articles/hello`, its untranslated path in that locale redirecting there with a 308, unless a public file, an endpoint, a redirect, an API route or a feed serves it, and with domains a host serves only its own locale's paths.
- `localize`, `alternate`, the `hreflang` links, the sitemap and `kay build --static` follow, and `kay check` checks links against the translated paths.
- A pattern no page serves, or a translation another page of the locale takes, stops the server.

### Messages

- Messages live in `src/messages/<locale>.ts`, one file per locale, `messages` in `i18n` naming another directory.
- Each exports its messages by default through `defineMessages`, nested as you like, a group never holding only keys named like plural forms (`one`, `other`...), which would read as one plural message.
- The default locale's file is the reference `kay check` holds the others to, and a key a locale lacks falls back to the default locale's text.
- A message whose line ends on a `// draft` comment is a draft (the line its key is on: a plural's opening brace counts, a group's does not mark the messages under it), as a machine translation is written: served as any message, reported by `kay check` (`draft-message`, warn) until a person deletes the comment or runs `kay i18n accept <locale> [dir]`, which deletes every draft comment of that locale's file.
- `kay i18n missing [locale] [dir] [--format text|json]` lists what each locale lacks against the default one: message keys, its libraries' catalogs included, and the slugs a localized collection has in the default locale and not in it, a draft counting as there; `--format json` prints `{ locales: { fr: { messages: [keys], entries: { news: [slugs] } } } }`.
- `kay i18n translate <locale> [--dry-run]`, added by `@kaynooo/kayjs-ai`'s `ai()` extension, translates what `kay i18n missing` lists with a model and writes it as drafts: messages `// draft`, an entry of a localized collection with its `draft: '<field>'` field set true or, without one, a first YAML line `# draft` (a CMS saving the entry removes it, `kay check` reports it as `draft-entry` until then); a text that drops a `{placeholder}` is never written.
- A key no locale has, as a computed one may be, fails the render in development and tests, is logged in the browser in development, and shows as itself in production.

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

- A library whose package.json declares `"kay": { "messages": "./src/messages" }`, kayjs-ui for one, gives its catalogs to every app that installs it with no line in `kay.config.ts`; a regional locale such as `fr-CA` reads its language's catalog when the library has none for the region. The app's file, then an extension of the same name, win over it.
- A library listed in `extensions` can bring catalogs of its own, `<locale>.ts` each in the directory its `messages` names (see [Extensions](component-libraries.md#extensions)).
- Every locale reads the library's messages with the app's laid over them key by key, so `auth: { title: 'Connexion' }` in `src/messages/fr.ts` replaces that one text of the library and keeps the rest.
- `t()` types the keys of both, and `kay check` holds each locale to the default one's keys, the library's included, so a locale the library does not translate is the app's to fill.
- The app needs no file of its own for a locale the library translates.
- Without `i18n`, a site is in its one language, its `lang` (`en` without one): `t()` reads its libraries' catalogs for it, with the app's `src/messages/<lang>.ts` laid over them when it has one, and `kay check` types the keys of both.
- Without `i18n`, `locale()` is that language, `localize()` gives a path back as written, and no page gets `hreflang` links, so a library's pages read their texts in any app.

### Texts from kay and its libraries

- What a visitor reads that kay or a library wrote, not the app, is looked up in the app's catalogs under `kay.*`, `ui.*` (kayjs-ui), `cms.*`, `auth.*` (kayjs-auth), `mail.*` (kayjs-mail) and `ai.*` (kayjs-ai) keys before its English, so one block of `src/messages/<locale>.ts` words them all for the site; a site without the keys reads the English it did, except where a library ships a catalog for the locale: kayjs-ui and kayjs-mail ship French, read after the app's own.
- `wording(key, english, params?)` from `kay/words` is that lookup for a library: the message at `key` when a catalog has it, else `english`, `{placeholders}` filled either way, with no failing on a missing key and no request needed; an island's source naming the key as a literal, `wording('ui.close', 'Close')`, sends the message to the browser as `t('key')` does, and a key no catalog has sends nothing. A `Date` param is written as the page's locale writes it (`4 oct. 2026`), in the English too. `pageLocale()` from it gives the locale to format a date in, and `sizeText(bytes, locale?)` writes a size in it (`1.5 MB`, `1,5 Mo`), the page's locale by default.
- `kay/words` is its own small module, about 0.3 KB gzipped in the browser, so a library's islands do not load all of `kay/i18n` for a label; it reads the page's messages as `t` does, and takes strings, `{placeholders}` and plural forms.
- A locale may give a `kay.*`, `ui.*`, `cms.*`, `auth.*`, `mail.*` or `ai.*` key the default locale does not, so a French block needs no English twin: `kay check` compares such a key's `{placeholders}` with the English the code holds (kay's table, or the library's installed sources) and reports one dropped or invented, but not the key's absence from the default locale.
- A per-action `messages`, a schema's `error` and a component's label prop stay the overrides, and win over the catalog.
- A schema refusal without an `error` reads `kay.invalid.<kind>`, Elysia's own wording when the site gives none: `required` (nothing sent), `tooShort` (`{min}`), `tooLong` (`{max}`), `pattern`, `tooSmall` (`{min}`), `tooBig` (`{max}`), `format` (`{format}`, the schema's format such as `email`), `tooFewItems` (`{min}`) and `tooManyItems` (`{max}`) for an array out of its `minItems` and `maxItems`, and `type` for anything else, such as a wrong type, an exclusive bound or a union no branch fits. The browser's form check before a post reads the same keys with the same params in the page's locale, a page with a checked form sending them (only those the catalogs word, so a site without them sends nothing and reads Elysia's English), and a schema's own `error` still wins.
- The other `kay.*` keys, with their English: `action.serverError` (Something went wrong on our side; try again later), `action.invalidFile` (Invalid file type), `action.bodyLimit` (Too large to send; {size} at most, the size written in the page's locale: `1 Mo`, `200 octets`), `offline.title` (Offline) and `offline.text` (This page needs a connection, and none is open.), the page the service worker gives offline for a page it did not keep, in the default locale, `protection.honeypot` (Leave this field empty), `protection.minTime.early` (Sent too fast; take a moment, then send it again), `protection.minTime.expired` and `protection.proofOfWork.expired` (This form has expired; send it again), `protection.proofOfWork.missing` (Turn JavaScript on to send this form), `protection.proofOfWork.wrong` (This form could not be checked; send it again), `protection.rateLimit` (Too many attempts; try again in {seconds} s).
- kayjs-ui's `ui.*` keys are listed in its `llms.txt`. kayjs-ai has one, `ai.chat.disclosure`, the line `Chat` shows that the visitor talks to an AI.

```ts
export default defineMessages({
  kay: {
    invalid: { required: 'Champ requis', tooShort: 'Au moins {min} caractères' },
    protection: { rateLimit: 'Trop d\'essais, réessayez dans {seconds} s' },
  },
})
```

### Helpers

- `t`, `locale`, `locales`, `localeName`, `direction`, `localize`, `alternate`, `formatNumber`, `formatDate`, `formatRelativeTime`, `relativeTime` and `formatList` come from `kay/i18n`, which works anywhere a request is served from: loads, templates, components, islands, actions and guards, and in `renderToString` outside one, in the site's default locale or the one its `locale` option names (see rendering).
- `t('greeting', { name })`, which a template, a fence or an island reads with no import unless the file names its own `t`, gives a message in the request's locale, its key and placeholders typed from the default locale's file.
- A number fills a placeholder formatted for the locale, `1 234` in French, and a date with `dateStyle: 'medium'`.
- An object of plural forms is picked by `count` through `Intl.PluralRules`, `zero` taking 0 whenever it is given.
- A key no locale has renders as itself.
- `const ago = relativeTime(() => post.date)`, its options `Intl.RelativeTimeFormat`'s, is a memo of that date relative to now, read as `{ago}` in the template, that goes on ticking: every second under a minute away, every minute under an hour, every hour past that, until the island ends, paused while the tab is hidden and caught up as it shows again.
- The server renders it relative to the moment the page is rendered at, which it writes into the page, and the island's first render in the browser reads that moment too, so hydrating changes nothing; it then moves to the browser's clock.
- Using it makes the component an island.
- `T` renders a message holding markup, such as a link mid-sentence: see [Messages holding markup](#messages-holding-markup).
- `formatNumber(value, options)` and `formatDate(value, options)` format through `Intl` for the request's locale, and so do `formatRelativeTime(date)`, a date relative to now in the largest unit it reaches, `3 days ago`, `yesterday` or `in 2 hours`, `formatRelativeTime(2, 'week')` in the unit given, and `formatList(['Ada', 'Grace'])`, `Ada and Grace`.
- In an island, give `formatRelativeTime` the moment it is relative to, `{ now }`, from the server, so the browser renders what the server did, or use `relativeTime`.
- `locales()` is the configured locales in `i18n`'s order, only the page's own without `i18n`; `localeName('fr')` is `Français`, `localeName('pt-BR')` is `Português (Brasil)`, each in its own language through `Intl.DisplayNames`, first letter capitalized, a code `Intl` cannot read as written.
- `direction()` is `rtl` or `ltr`, for the request's locale or the one given.
- `locale()` names it, as do `ctx.locale` in pages, guards, endpoints and actions, and `t()`, `wording()` and `locale()` in API handlers and their `onError`, the locale of the page the call came from, the site's `lang` (English by default) without `i18n`.
- A link written as the default locale names a page, `a(href="/about")`, goes to the page's locale's copy as it renders: `/en/about` on an English page, translated by `paths`, on the locale's host with `domains`.
- So do links to a localized collection's feed, the links of Markdown entries, and those an island renders in the browser, so converting a site needs no change to its links.
- A link carrying `hreflang` stays as written, as a language switcher's must: `a(href={alternate('fr')} hreflang="fr")`.
- So does one already under a locale's prefix, one to a file a param would take (`/blog/cover.png`), and one to no page, such as an API route or a public file.
- `localize('/about')` is that path in the request's locale, or in the one given as second argument, checked like any link, for a path that is no `a`'s href: a redirect, a `fetch`, a URL to share.
- `alternate('en')` is the page being rendered in another locale, for a language switcher.
- With domains, a locale on another host gives its absolute URL.
- An island gets only the messages it uses: those it looks up while rendering on the server and the keys its own source passes `t()`, or `T` as `key`, as they are written.
- A key built at runtime, or looked up only in a module the island imports, reaches the browser only if the server render used it.
- A content collection with `localized: true` keeps one folder per locale, `src/content/posts/en/hello.md`, and reads the request's locale's entries, the default locale's standing in; see content.
- An action runs in the locale of the page it was sent from, the one its `ctx.params` are read off (see actions), then the cookie and the browser's languages.

### The page's markup

- The page's `<html lang>` is its locale, with `dir="rtl"` for one written right to left, such as Arabic, Hebrew, Persian or Urdu, so the page lays itself out that way and CSS logical properties, `margin-inline-start`, follow.
- With `site`, every page links its copy in each locale, `<link rel="alternate" hreflang>`, `x-default` being the default locale's, its canonical URL is its own locale's, and the sitemap lists every copy with the others as `xhtml:link` alternates.
- `kay build` prerenders a page once per locale.

### French typography

- A page whose `lang` starts with `fr` (the site's `lang`, or the locale of a French page under `i18n`) is written with a non-breaking space (U+00A0) in place of the plain one before `:`, `;`, `!`, `?` and `»`, and after `«`, so a mark never wraps to the next line alone. Nothing is typed: `Voulez-vous continuer ?` in a template, a prop, a `.ts` constant or a Markdown collection comes out right.
- It runs once over the page's markup on the server, so the shell, the blocks of an `await` as they stream, the pages `kay build` prerenders and exports, the server islands, the error and not-found pages and the offline page all have it, and a page in any other language costs nothing. It rewrites the text and the `alt`, `title`, `aria-label` and the `content` of a description or title meta (`description`, `og:description`, `og:title`, `twitter:description`).
- It leaves the text of `code`, `pre`, `kbd`, `samp`, `script`, `style`, `textarea`, comments, other attributes, URLs and times such as `12:30` as they are, works within one text node, so a colon right after a tag stays, and keeps any U+00A0 or U+202F already typed. Markup it cannot read ends the pass at that point, the rest going out as it was.
- `typography: false` in `kay.config.ts` turns it off. An island hydrating over the markup writes its own text, plain spaces included, so the spaces of its static text are the ones typed.

### Messages holding markup

- `T` from `kay/i18n` renders a message whose tags are filled by the blocks of their names, `intro: 'Read <about>our story</about>, {name}.'` through:

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
- Tags do not nest, and a plural's `count` goes as a prop like any placeholder.
- In an island, `T` renders again when a placeholder changes.
- `t()` gives such a message with its tags as written.

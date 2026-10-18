---
title: Privacy
order: 9.5
description: What kay keeps about visitors and for how long, erasing a person who asks, counting visits through your own origin, analytics behind consent and photos without their metadata.
---

Kay sets no cookie and keeps nothing about a visitor until the app uses a feature that does. Nothing it keeps follows a visitor across sites.

This page lists what each feature keeps, for a site's privacy notice and for the consent your app needs. It also shows how to erase a person who asks, as the GDPR requires.

## Cookies

| Cookie | Set by | Kept |
| --- | --- | --- |
| `session`, `__Host-session` over https | a session the app writes to | 30 days unused, 90 at most, by default |
| `kay_flash` | an action redirecting with a flash message | 60 seconds |
| `kay_locale` | a visitor picking a locale | a year |
| `kay_analytics` | the consent notice or information line of `analytics()` | a year |
| `kay_preview` | `enterPreview()`, for an editor | an hour by default |
| the name given to `persisted()` | a persisted signal | a year, or its `maxAge` |

The first four, and `kay_analytics`, which only remembers the visitor's answer, are necessary for what the visitor asked, so they need no consent. A persisted signal holds what the app puts in it. A theme or a language is necessary, and anything else waits for consent.

Under a `base`, `kay_flash`, `kay_locale` and `kay_preview` are set for that path alone. Before 1.52 the locale cookie was `kay-locale`; kay still reads it.

## What the server keeps

- **Request logs**: method, path without its query string, status, duration and request id. No address, user agent or cookie.
- **Sessions** with a store: until they expire or the visitor signs out. `sqliteStore` drops expired ones every hour.
- **Rate limits**: counted by address in memory, or in `sqliteRates(path)` pseudonymised, a salted hash keyed by the session's or the preview's secret once one is set, and dropped once their window closes.
- **Jobs**: a waiting job's payload until it runs, a failed one's for 30 days from when its last attempt was due, or what the queue's `keepFailed` says.
- **Rooms**: a message 30 seconds in `sqliteRooms`.
- **Uploads**: until the app deletes them, without the metadata a camera writes in a JPEG, PNG or WebP.

Every SQLite file kay creates is readable by the server's user alone.

## Erasing a person

Delete the app's own rows, then what kay keeps for them.

```ts
import { files, queue, sqliteStore } from 'kay/server'
import { db } from './db'
import { sendMail } from './mail'

export const sessions = sqliteStore('data/sessions.sqlite')
export const mail = queue('mail', async (job: { userId: string, to: string, text: string }) => sendMail(job))

export async function erase(userId: string) {
  const user = await db.users.delete(userId)

  if (user.avatar !== undefined)
    await files.delete(user.avatar)

  await sessions.deleteWhere(data => data.userId === userId)
  await mail.remove(job => job.userId === userId)
}
```

`files.delete` also deletes every resized variant of the file and every social card drawn on it.

Sessions kept in the cookie alone, without a store, cannot be listed. They end when they expire, or for everyone when the secret is replaced.

## Counting visits

Most analytics tools work the same way: a script from their domain posts each visit to their server. That asks you to paste a script, add the tool's domain to your content security policy, and lose the visits that ad blockers drop.

`analytics()` skips all of it. kay serves a small script from your own site, and your server passes each visit on to the tool:

```ts
import { defineConfig } from 'kay/server'
import { analytics } from 'kay/analytics'

export default defineConfig({
  extensions: [analytics({ provider: 'plausible', domain: 'example.com' })],
})
```

Plausible, Umami (give it `websiteId`), Simple Analytics (`provider: 'simpleanalytics'`) and Matomo (`siteId` and `host`) work this way. All four set no cookie and can be run on your own server, so they count from the first page, with an information line and a way to opt out (see below). Matomo only gets the visitor's address if you give it a `tokenAuth` of a user with write access to the site, as Matomo requires; without one it sees your server's address.

Fathom and Cloudflare Web Analytics are different. Like Google Analytics and `custom`, they wait for the visitor's yes unless you write `consent: false`. They take data only from their own scripts, so kay cannot send for them. `provider: 'fathom'` (`siteId`) and `provider: 'cloudflare'` (`token`) add their script to your pages and open the content security policy for their domains. Their data does not pass through your site.

For any other tracker that is a script posting to an endpoint, use `provider: 'custom'` with `script` and `endpoint`. kay serves a copy of the script from your site with the endpoint in it pointed at your site, and passes what the script posts on. The endpoint must appear in the script exactly as you write it.

The script counts the page when it loads and again after each page swap. It needs a running server, so `kay build --static` warns that an exported site cannot count. It does nothing while you run `kay dev` or tests: only a server with `NODE_ENV=production` passes visits on.

### Google Analytics 4

`provider: 'ga4'` sends each page view to Google Analytics from your server, through its Measurement Protocol. It needs the `measurementId` of your web data stream (`G-` and letters) and an `apiSecret`, which you make in Google Analytics under the data stream's Measurement Protocol API secrets. The secret stays on your server. Use `host: 'https://region1.google-analytics.com'` to collect in the EU.

```ts
analytics({ provider: 'ga4', measurementId: 'G-ABC123XYZ', apiSecret: 'secret', consent: true })
```

Google normally keeps a visitor's id in a cookie. kay sets none, but that does not remove the need to ask: the script still reads the visitor's screen and language, and Google Analytics is never exempt from consent.

Your server makes the id from the visitor's address and browser with a random key that changes every day and is never stored, so the id tells a visitor apart for one day and cannot be turned back into an address. Two servers behind a balancer count one visitor twice. No id is made and nothing is sent until the visitor said yes, which is the default for Google Analytics.

Google does not get the visitor's address unless you give `address: true`, which sends it as `ip_override` so Google can place the visit; otherwise Google places every visit at your server.

Behind a CDN or proxy set `proxy`, or every visitor shares the proxy's address and one id. Keep `host` on https, as the secret travels in the request. Because there is no Google tag on the page, check Realtime and the engagement numbers in your reports, which Google builds partly from tag data. A very long page address may also be cut by Google's limit of 100 characters per value.

### What the tool receives

- The page address without its `#` part, and from its query only `utm_*`, `ref` and `source`, so a token or an email in a link never reaches the tool.
- The page the visitor came from, without its query, plus the title, the screen size, the language and the browser's `User-Agent`.
- The visitor's address only if the tool needs it to tell visitors apart. Plausible gets it as `X-Forwarded-For` and Umami in the data it receives. Matomo with a `tokenAuth`, Google Analytics with `address: true` and a custom tracker with `address: true` get it too. Simple Analytics never gets it. Behind a CDN or proxy, set `proxy` so the address is the visitor's and not the proxy's: without it Plausible sees one visitor, and the limit below is shared by your whole site.
- Nothing else: no cookie, no `Referer`, no `Authorization` header of the visitor.

### Asking first

Google Analytics, Fathom, Cloudflare and `custom` ask by default, as if you wrote `consent: true`; for Plausible, Umami, Simple Analytics and Matomo you add it. Kay shows a notice until the visitor chooses. Nothing is counted before a yes, and the server checks that on every visit rather than trusting the page. The answer is kept in the `kay_analytics` cookie for a year, for your `base` path.

```ts
analytics({
  provider: 'umami',
  websiteId: '0b2f4a52-0000-4000-8000-000000000000',
  consent: {
    text: { en: 'Can we count your visit?', fr: 'Pouvons-nous compter votre visite ?' },
    agree: { en: 'Yes', fr: 'Oui' },
    refuse: { en: 'No', fr: 'Non' },
  },
})
```

The notice is a labelled region that Tab reaches, and kay never moves the focus to it. With Fathom or Cloudflare, a refusal after the script loaded reloads the page so it runs no more.

Give any element a `data-analytics-consent` attribute and a click on it shows the notice again, so a visitor can change their mind. Your own scripts read the answer with `window.kayAnalytics.consent()`, and a `kay:consent` event fires on `document` when it changes. An app with its own banner uses `consent` instead, below.

### Counting without asking

Plausible, Umami, Simple Analytics and Matomo count at once, and kay shows a short information line with an `OK` button and an `Opt out` button. Opting out writes `kay_analytics=no`, and your server then passes on nothing for that visitor, on any page. Word it with `info: { text, ok, optOut }`, each a string or one per language. If your site already informs visitors and lets them object, write `info: false`.

To count Google Analytics, Fathom, Cloudflare or a custom tracker without asking, write `consent: false`. You then answer for it yourself: kay shows no notice for Fathom, Cloudflare or a custom tracker, and only the information line for Google Analytics. Before 1.55 these counted every visit without asking, and `kay check` reports the ones that did not say which they want.

### The CNIL exemption, and what it asks

Not asking is lawful only where an exemption applies, and a cookieless id is not one by itself: reading the visitor's screen, language and title falls under the same ePrivacy rule as a cookie. The French CNIL exempts audience measurement when all of this holds:

- The numbers are anonymous statistics for your own site, used for nothing else.
- The tool does not reuse the data and does not follow a visitor across sites.
- Visitors are told, and can object easily.
- Data is kept 25 months at most.

This is one regulator's position. Other countries may ask for consent anyway. Plausible, Umami and Matomo get the visitor's address to tell visitors apart, so the exemption holds only if the tool drops it: run it yourself, or check its terms. Google Analytics is never exempt. The information line and the opt-out are the notice and the objection the exemption asks for, not the whole of it.

### Processors, agreements and transfers

Whichever tool you use, your privacy notice names it, what it is for and how long the data stays, and you sign its data processing agreement before counting a visit. Check each provider's current terms, as these change.

| Provider | Your legal basis | Who it is | Agreement and transfer |
| --- | --- | --- | --- |
| Plausible, Umami, Simple Analytics or Matomo on your own server | The exemption above, or consent | You, with no third party | None to sign, and no transfer if your server is in the EU |
| Plausible Cloud, Simple Analytics, Matomo Cloud | The same | A processor working for you | An agreement the provider offers, with EU hosting |
| Umami Cloud | The same | A processor | An agreement the provider offers, US hosting, so a transfer mechanism is needed |
| Google Analytics | Consent, always | Google, a processor (and for some uses a controller) | Google's data processing terms, accepted in your account, and a US transfer under the Data Privacy Framework or standard clauses |
| Fathom | Consent | A processor (Fathom Analytics, Canada) | An agreement the provider offers, and a transfer to Canada |
| Cloudflare Web Analytics | Consent | Cloudflare, a processor | Cloudflare's agreement in its customer terms, and a US transfer under the Data Privacy Framework or standard clauses |
| `custom` | Consent | Whoever runs the endpoint | Your own agreement with them |

### Asking in your own banner

If your site already has a cookie banner or a settings page, ask there. Pass `consent: { notice: false }` so kay shows no notice of its own, and use `consent` from `kay/analytics` in an island. `consent()` is the visitor's answer, `'yes'`, `'no'` or `''` while they have not chosen. `consent.set('yes')`, `'no'` or `''` records a new one; an empty answer asks again.

```ts
analytics({ provider: 'ga4', measurementId: 'G-ABC123XYZ', apiSecret: 'secret', consent: { notice: false } })
```

```kay
---
import { consent } from 'kay/analytics'
---
if consent() === ''
  aside(aria-label="Visit statistics")
    p We count visits only if you agree.
    button(onClick={() => consent.set('yes')}) Agree
    button(onClick={() => consent.set('no')}) Refuse
else
  button(onClick={() => consent.set('')}) Visit statistics: {consent() === 'yes' ? 'on' : 'off'}, change
```

`consent` works only with the `consent` option on `analytics()`.

A page that calls `consent()` is rendered for each visitor, so read it in the island that needs it rather than in a layout every page shares, which a CDN could no longer cache.

It is the same cookie kay's notice writes, so the two never disagree, and the server still sends nothing without a yes. A page is rendered with the answer already in the request, so the banner does not flash for a visitor who answered. The answer is shared by every island and survives page swaps. `consent.set` works in the browser only, in a handler or an effect; on the server `consent()` only reads.

### Who may post a visit

The route is open to anyone, so it checks everything. It refuses a page that is not on your host (add other hosts with `hosts: ['www.example.com']`; a proxy that rewrites the `Host` header needs your real host there, and kay logs a warning when it drops a visit for this), a body over 4 KB, a post from another site, and more than 120 visits a minute from one address. The tool's address comes from your config alone, never from the request.

## Another script behind consent

For a script that needs the visitor's browser, such as a tracker that sets cookies, an island keeps the visitor's answer in a persisted signal and loads the script once it is yes. A button stays to ask again.

Refusing after agreeing clears the script's cookie and reloads, so the visitor can withdraw as easily as they agreed.

```kay
---
import { persisted } from 'kay'

const consent = persisted('consent', '')

effect(() => {
  if (consent() === 'yes')
    document.head.append(Object.assign(document.createElement('script'), { src: '/stats.js', defer: true }))
})

// Refusing after agreeing clears what the script stored and reloads, so it no longer runs.
function withdraw() {
  const agreed = consent() === 'yes'

  consent = 'no'

  if (agreed) {
    document.cookie = '_stats=; max-age=0; path=/'
    location.reload()
  }
}
---
if consent() === ''
  aside(aria-label="Visit statistics")
    p We count visits only if you agree.
    button(onClick={() => consent = 'yes'}) Agree
    button(onClick={() => withdraw()}) Refuse
else
  button(onClick={() => consent = ''}) Visit statistics: change my choice
```

## Photos

`files.put` keeps only what draws a JPEG, PNG or WebP, told by its bytes whatever its name. That is its pixels, colour profile and orientation.

The EXIF, XMP, IPTC and text a camera or phone writes, such as where and when the photo was taken, go. So does any metadata kay does not know.

An AVIF or HEIC is stored as it came, and so is a file kay cannot read through, which it logs. Use `files.put(file, { keepMetadata: true })` to keep everything, for an archive that needs it.

Store a photo of a person that only some visitors may see with `private: true`. It is served only through a link the page signed.

## Error trackers

`onError` gets the whole request, or none for an error met outside one. Send a tracker its path rather than `request.url`, whose query may hold an address or a token.

```ts
import { defineConfig, requestId } from 'kay/server'

export default defineConfig({
  onError: (error, request) => tracker.capture(error, request && { path: new URL(request.url).pathname, id: requestId(request) }),
})
```

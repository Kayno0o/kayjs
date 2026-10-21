# Analytics and Web Vitals

Count visits and measure real page loads through your own origin, and ask for the visitor's consent. What kay keeps otherwise, and erasing a person, is in [Privacy and personal data](privacy.md).

## Count visits through your own origin

`analytics()` from `kay/analytics` serves a small tracker from the app and forwards each visit to the provider from the server, so the CSP needs no third-party host and an ad blocker has no provider domain to match:

```ts
import { defineConfig } from 'kay/server'
import { analytics } from 'kay/analytics'

export default defineConfig({
  extensions: [analytics({ provider: 'plausible', domain: 'example.com' })],
})
```

- `provider` is `'plausible'` (`domain`, else the visited host), `'umami'` (`websiteId`), `'simpleanalytics'` (`hostname`, else the visited host) or `'matomo'` (`siteId`, `host`, optional `tokenAuth`); each but Matomo takes `host` for a self-hosted instance or another endpoint. All four are cookieless and take visits from the server, so they count at once, with an information line and an opt-out (see the `info` bullet). Matomo gets the visitor's address (`cip`) only with a `tokenAuth` of a user with write access, else it sees this server's.
- `'fathom'` (`siteId`, `spa`) and `'cloudflare'` (`token`) take data only from their own scripts (Cloudflare says so for its endpoint), so they are the exception to "through your origin": their script is added to the head and the CSP opened for their domains (`cdn.usefathom.com`; `static.cloudflareinsights.com` and `cloudflareinsights.com`). With `consent`, kay's script loads theirs after the yes, and a refusal after it loaded reloads the page without it; with `consent: false` it loads theirs until the visitor opts out on the information line.
- `'custom'` (`script`, `endpoint`, optional `address: true`) is any tracker that is a script posting to an endpoint: kay fetches `script` (an hour cached, 512 KB at most), serves it at `/_kay/analytics/script.js` with every `endpoint` written in it replaced by `/_kay/analytics/collect`, and passes what it posts to `endpoint`: a body of 64 KB at most, JSON, text or form content only, the visitor's `User-Agent` and, with `address: true`, `X-Forwarded-For`. The tracker counts page swaps itself, and the endpoint must appear in the script as written.
- `'ga4'` (`measurementId` as `G-XXXXXXXXXX`, `apiSecret` from the data stream's Measurement Protocol API secrets, optional `host` such as `https://region1.google-analytics.com` for EU collection, optional `address: true`) sends a `page_view` to `/mp/collect` from the server: no Google script, cookie or CSP exception, and the secret stays on the server. There is no browser cookie to hold Google's `client_id`, so the server makes one (`<digits>.<digits>`) as a keyed hash of the visitor's address and `User-Agent` with a random key that changes every UTC day and lives in the process: it tells a visitor apart for a day, cannot be turned back into an address, and exists only for a visit that passed the consent check. Two processes behind a balancer count a visitor twice. `session_id` is the half hour the visit falls in and `engagement_time_msec` a fixed 100. The address is not passed on unless `address: true`, which sends it as `ip_override` so Google places the visit; otherwise Google places visits at this server. Behind a CDN set `proxy`, else every visitor shares the proxy's address and one id. Keep `host` on https, as the secret is in the request. Google reports Measurement Protocol events without a tag only in part (Realtime and engagement metrics are the ones to check), and a long `page_location` may be cut by Google's 100 character value limit.
- The tracker is `/_kay/analytics.js`, added to every page's head, and counts the page on load and on each page swap (`kay:navigate`), the page the visitor left as referrer. Visits go to `POST /_kay/analytics` under the `base`.
- It needs a running server (Fathom and Cloudflare with a notice or the information line work in a `kay build --static` export, which writes `/_kay/analytics.js` beside the pages): `kay build --static` warns, since the exported pages would call a route that answers 404. Only `NODE_ENV=production` forwards; `kay dev` and tests answer the same and send nothing.
- A visit is answered at once and passed on in the background (200 waiting at most, then dropped).
- `consent` is `true` (or `{ text, agree, refuse }`, each a string or one per language: `{ text: { en: 'Count?', fr: 'Compter ?' } }`) to wait for the visitor's yes, and left out it is `true` for `ga4`, `fathom`, `cloudflare` and `custom`, which are not self-hostable cookieless counters: write `consent: false` to count them without asking, which the app then answers for. Nothing is counted before the yes: a notice kay builds (its code is `/_kay/analytics/notice.js`, fetched only when the visitor has to be asked) (a labelled `section` at the end of the body, reached by Tab, focus not moved to it on load; a click on `data-analytics-consent` opens it on its first button and the answer gives focus back; it survives a page swap) asks until they choose, the answer is the `kay_analytics` cookie (`yes` or `no`, 180 days for a refusal as for a yes, `SameSite=Lax`, for the `base` path; `consent: { maxAge }` seconds, 13 months at most), and the server forwards nothing without `yes`, whatever the request claims.
- The notice and the information line take the site's look: kayjs-ui's tokens when present (surface, text, accent, border, radius, following its color scheme), else the page's background and text; `--kay-notice-background`, `-color`, `-border`, `-radius`, `-shadow`, `-accent`, `-on-accent` and `-line` (the refuse button's border) on `:root` override them.
- Any element with `data-analytics-consent` reopens the notice, so a visitor changes their mind as easily as they chose. The notice is a script of its own, fetched on the first ask and again on the next one when the fetch failed; the notice and a provider's script copy the nonce of the tracker tag, so an app with a nonce-only CSP puts its nonce on that tag.
- `plausible`, `umami`, `simpleanalytics` and `matomo` count at once unless `consent` asks, and show an information line (a labelled `section` like the notice) with `OK` and `Opt out`; `Opt out` writes `kay_analytics=no` and the server forwards nothing for that visitor, from any page. `info: { text, ok, optOut }` (strings or one per language) words it, `info: false` leaves it out for an app that informs and lets visitors object itself (`ga4`, `fathom`, `cloudflare` and `custom` with `consent: false` show it too); an `info` object is refused when `consent` asks, where nothing shows it. Fathom, Cloudflare and `custom` with `consent: false` and no `info: false` get the line through kay's loader: it adds their script after its own and not at all once `kay_analytics=no` is set, and `Opt out` after it ran reloads the page without it (the page view of that load was already counted by the script, as with the counters). With `info: false` their script goes in the head as it is, and the app lets visitors object itself. A static export writes the loader and the line's files for them.
- The notice and the information line read in English, or in kay's French on a page whose `lang` is `fr` (`fr-CA` too); the app's `consent` / `info` strings win (a plain one for every language). They name the provider (`with Plausible`, `{provider}` in the app's `text` becomes it, the endpoint's host for `custom`) and link `policyUrl` (a path without the `base`, or an http(s) address) as `Privacy policy` (`policy` in `consent` or `info`, a string or one per language).
- `exclude: ['/account', '/*/admin']` leaves pages out: the tracker counts nothing for a path with those leading segments (under the `base`, `*` for one segment such as a locale: list `/admin` and `/*/admin`) or for a page whose head says `noindex`, or for a page a guard covers (the page carries `<meta name="kay-guarded">`, so `/account` behind a guard needs no `exclude`); the server drops a visit to an `exclude` path too, so a tracker cached from before counts nothing for it either, unless a proxy takes the `base` off and the tracker predates this. It and `titles` are for the providers kay counts for, not Fathom, Cloudflare or `custom`, where they are type errors (and refused at start). Without `titles: true` a visit carries the path alone.
- `window.kayAnalytics.consent()` reads the answer (`'yes'`, `'no'` or `''`) and `kay:consent` fires on `document` when it changes. An app with its own banner or settings page uses `consent` instead, see the next section.
- A visit is refused unless the page it names is on the host the request came to, or one in `hosts: ['www.example.com']`, which a proxy rewriting `Host` needs for the real one (a dropped visit logs a warning, once a minute at most); a body past 4 KB (413), a cross-site post (403) and more than 120 visits a minute from one address (429) are refused too.
- What a provider gets: the page URL without its hash and with only the `utm_*`, `ref` and `source` parameters of its query, the referrer without its query, the title only with `titles: true`, the screen size and language, and the visitor's `User-Agent`, cleaned of control characters. No cookie, `Referer` or `Authorization` of the visitor goes with it.
- A provider answering 4xx or 5xx to a visit (a wrong site id, domain or secret) logs one warning per provider and status a minute, naming the status and no URL, so lost stats show in the log.
- The visitor's address is sent only to a provider that needs it to tell visitors apart or place them: Plausible as `X-Forwarded-For`, Umami as `ip` in the payload, Matomo as `cip` with a `tokenAuth`, GA4 as `ip_override` and `custom` as `X-Forwarded-For`, the last two only with `address: true`; Simple Analytics not at all. It is the one `proxy` yields, so set `proxy` behind a CDN: without it every visitor shares the proxy's address, Plausible counts one visitor and the 120 a minute limit is shared by the whole site.

## Measure how fast pages load for real visitors

`vitals()` from `kay/analytics` reports the LCP, CLS and INP of real visits from your own origin and shows a 75th percentile per route, with no script, route or table on your side:

```ts
import { defineConfig, sqliteData } from 'kay/server'
import { vitals } from 'kay/analytics'

export default defineConfig({
  store: sqliteData('data/app.sqlite'),
  extensions: [vitals({ guard: { load: async () => (await import('./src/auth')).auth.guard({ require: 'admin' }) } })],
})
```

- Every page's head gets `/_kay/vitals.js`, about 700 bytes of gzip, `defer`, so it is off the critical path, and is revalidated on every load (a 304 while unchanged) as its body follows the consent gate; a site without `vitals()` loads none. It sends one `POST /_kay/vitals` (through `sendBeacon`, under the `base`) per view, when the tab is hidden: no request at load, and once per view: what a tab gathers after it was hidden and shown again is not sent. A page swap (`kay:navigate`) sends the view it replaced and starts a new one with no LCP, and a page restored from the back-forward cache starts a new view too.
- The body is `{ p, l, c, i }` (path, LCP in ms, CLS score, INP in ms; a metric the view lacks is left out). The server matches the path to the page's route (`/blog/:slug`), so the store never holds a row per URL.
- `store.vitals` keeps counts per UTC day, route, metric and log bucket (about 10 % wide), seven days back; `sqliteData(path)` holds it, so replicas sharing the file add up, and another store implements `VitalsStore` (`add`, `counts`). Without one it is this process's memory, and a production start warns.
- The screen is `prefix` (`/vitals` by default), a table per route of LCP, CLS and INP with their view count, rated `good` up to 2.5 s, 0.1 and 200 ms, `poor` past 4 s, 0.25 and 500 ms. It answers 403 without a `guard` (a function like `auth.guard({ require: 'admin' })`, or `{ load }` returning one, run on the first request); the numbers are collected either way. `vitalsReport()` from `kay/analytics` reads the same numbers in code. Under `trailingSlash` and `i18n` a route shows as the first shape it is served at, such as `/fr/about`, every locale counted together.
- No cookie, address, title or user agent is kept. `consent: true` waits for `kay_analytics=yes` (kay's notice writes it with `analytics({ consent })`, else your own banner sets it with `consent.set('yes')`, which works without a tracker), `consent: false` never waits; unset it follows `analytics({ consent })` when the site has it, and counts at once otherwise, with no notice. A visitor with `kay_analytics=no` is never counted, from any page. The script served carries the gate, so a visitor who has not said yes sends nothing.
- A report is refused when cross-site (403), over 512 bytes (413), malformed or out of range (400), or past 300 a minute from one address (429). `kay dev`, a declined visitor and a path no page serves get 204 and keep nothing.
- It needs a running server: `kay build --static` refuses it, as the screen cannot be guarded in an export.

## Consent, legal basis and processors per provider

Reading the device (screen, language, title) and storing on it fall under ePrivacy art. 5(3), cookie or not, so a cookieless id does not remove the need for consent by itself. The CNIL exempts audience measurement only when all hold: the purpose is anonymous statistics for the site's own account, the provider reuses the data for nothing else and tracks no one across sites, visitors are told and can object easily, and the data is not kept past 25 months. That is one regulator's position: other EU states may ask for consent. Raw addresses reach `plausible`, `umami` and `matomo` for visitor counting, so the exemption holds only if that tool drops them (self-hosted, or its DPA says so). `ga4` is never exempt. kay shows the information line and opt-out in the ungated mode, which is the notice and objection the exemption asks for, not the whole exemption.

| Provider | Basis kay assumes | Role | DPA and transfer (check the provider's current terms) |
| --- | --- | --- | --- |
| `plausible`, `umami`, `matomo` with your own `host` | CNIL exemption (ungated) or consent | the app runs it, no third party | none to sign, no transfer if the host is in the EU |
| Plausible Cloud, Matomo Cloud, Simple Analytics | the same | processor for the app | DPA offered by the provider, an EU region available; Simple Analytics gets no visitor address from kay |
| Umami Cloud | the same | processor | DPA offered, check its hosting region for a transfer |
| `ga4` | consent, always | Google a processor (and for some uses a controller) | Google's data processing terms accepted in the account, US transfer under the Data Privacy Framework or SCCs |
| `fathom` | consent | processor (Fathom Analytics, Canada) | DPA offered, check the transfer to Canada |
| `cloudflare` | consent | Cloudflare a processor | Cloudflare's DPA in its customer agreement, US transfer under the Data Privacy Framework or SCCs |
| `custom` | consent | whoever runs the endpoint | the app's own DPA with it |

The table is kay's conservative default, not a finding that a provider cannot be exempt: Fathom and Cloudflare call themselves cookieless, and `consent: false` is the app's to answer for, kay supplying the line and the opt-out. The CNIL also caps a tracer's life at 13 months (`kay_analytics` lasts 180 days, `consent.maxAge` up to 13 months) and wants an address truncated or dropped. Terms change: check each before relying on the table.

The privacy notice names the provider, the purpose and the retention, and the app signs the DPA before counting a visit.

## Ask for analytics consent in your own UI

`consent` from `kay/analytics` is a signal holding the visitor's answer to `analytics({ consent })`: `'yes'`, `'no'` or `''` while they have not chosen. Read it as `consent()`, answer with `consent.set('yes')`, `'no'`, or `''` to ask again. It reads and writes the `kay_analytics` cookie kay's own notice uses, so the two never disagree and the server still forwards nothing without the yes. Pass `consent: { notice: false }` to show no notice of kay's (a `data-analytics-consent` click opens none either) and ask in your own UI:

```ts
import { defineConfig } from 'kay/server'
import { analytics } from 'kay/analytics'

export default defineConfig({
  extensions: [analytics({ provider: 'ga4', measurementId: 'G-ABC123XYZ', apiSecret: 'secret', consent: { notice: false } })],
})
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

- A page renders with the answer in the request's cookie and an island starts with the same, so nothing flashes; the signal follows `kay:consent`, so a change made anywhere, a page swap included, reaches every island reading it.
- `consent` needs the `consent` option on `analytics()`; `consent.set('yes')` starts counting at once (a Fathom or Cloudflare script loads); `'no'` or `''` after a yes reloads the page when a provider's script already ran, and `''` shows kay's notice again unless `notice: false`.
- A page that calls `consent()` renders per visitor, so one in a shared layout is no longer served from a CDN cache or prerendered with an answer; read it in the island that needs it.
- `consent.set` is for the browser, in a handler or an effect; on the server it throws, and `consent()` only reads.


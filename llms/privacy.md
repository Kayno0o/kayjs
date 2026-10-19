# Privacy and personal data

What kay keeps about visitors, where and for how long, and what an app calls to erase a person who asks, as the GDPR has it.

kay sets no cookie and stores nothing of a visitor until the app uses a feature that does, and none of what it keeps tracks a visitor across sites; the Reference lists each cookie and what the server keeps, for the app to decide what its notice and consent need.

## Common tasks

### Erase a person on request

Delete the app's own rows first, then the sessions and jobs kay keeps for them and the files they uploaded:

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

### Load a script only once the visitor agreed

For a script that needs the visitor's browser, such as a tracker that sets cookies, an island keeps the answer in a persisted signal, loads the script once it is yes, and keeps a button that asks again, where refusing withdraws an earlier yes:

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

### Count visits through your own origin

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
- `consent` is `true` (or `{ text, agree, refuse }`, each a string or one per language: `{ text: { en: 'Count?', fr: 'Compter ?' } }`) to wait for the visitor's yes, and left out it is `true` for `ga4`, `fathom`, `cloudflare` and `custom`, which are not self-hostable cookieless counters (before 1.55 they counted every visit): write `consent: false` to count them without asking, which the app then answers for. Nothing is counted before the yes: a notice kay builds (its code is `/_kay/analytics/notice.js`, fetched only when the visitor has to be asked) (a labelled `section` at the end of the body, reached by Tab, focus not moved to it on load; opened by a click on `data-analytics-consent` it focuses its first button and gives focus back to that control after an answer; it survives a page swap) asks until they choose, the answer is the `kay_analytics` cookie (`yes` or `no`, 180 days for a refusal as for a yes, `SameSite=Lax`, for the `base` path; `consent: { maxAge }` in seconds, 13 months at most), and the server forwards nothing without `yes`, whatever the request claims.
- Any element with `data-analytics-consent` reopens the notice, so a visitor changes their mind as easily as they chose. The notice is a script of its own, fetched on the first ask and again on the next one when the fetch failed; the notice and a provider's script copy the nonce of the tracker tag, so an app with a nonce-only CSP puts its nonce on that tag.
- `plausible`, `umami`, `simpleanalytics` and `matomo` count at once unless `consent` asks, and show an information line (a labelled `section` like the notice) with `OK` and `Opt out`; `Opt out` writes `kay_analytics=no` and the server forwards nothing for that visitor, from any page. `info: { text, ok, optOut }` (strings or one per language) words it, `info: false` leaves it out for an app that informs and lets visitors object itself (`ga4`, `fathom`, `cloudflare` and `custom` with `consent: false` show it too); an `info` object is refused when `consent` asks, where nothing shows it. Fathom, Cloudflare and `custom` with `consent: false` and no `info: false` get the line through kay's loader: it adds their script after its own and not at all once `kay_analytics=no` is set, and `Opt out` after it ran reloads the page without it (the page view of that load was already counted by the script, as with the counters). With `info: false` their script goes in the head as it is, and the app lets visitors object itself. A static export writes the loader and the line's files for them.
- The notice and the information line name the provider (`with Plausible`, `{provider}` in the app's own `text` becomes it, `with Google Analytics`, the endpoint's host for `custom`) with no wording from the app, and link `policyUrl` (a path without the `base`, or an http(s) address) as `Privacy policy` (`policy` in `consent` or `info`, a string or one per language).
- `exclude: ['/account', '/*/admin']` leaves pages out: the tracker counts nothing for a path with those leading segments (under the `base`, `*` for one segment such as a locale: list `/admin` and `/*/admin`) or for a page whose head says `noindex`; guard such pages with `exclude` or `page = { noindex: true }`. It and `titles` are for the providers kay counts for, not Fathom, Cloudflare or `custom`, where they are type errors (and refused at start). Without `titles: true` a visit carries the path alone.
- `window.kayAnalytics.consent()` reads the answer (`'yes'`, `'no'` or `''`) and `kay:consent` fires on `document` when it changes. An app with its own banner or settings page uses `consent` instead, see the next section.
- A visit is refused unless the page it names is on the host the request came to, or one in `hosts: ['www.example.com']`, which a proxy rewriting `Host` needs for the real one (a dropped visit logs a warning, once a minute at most); a body past 4 KB (413), a cross-site post (403) and more than 120 visits a minute from one address (429) are refused too.
- What a provider gets: the page URL without its hash and with only the `utm_*`, `ref` and `source` parameters of its query, the referrer without its query, the title only with `titles: true`, the screen size and language, and the visitor's `User-Agent`, cleaned of control characters. No cookie, `Referer` or `Authorization` of the visitor goes with it.
- A provider answering 4xx or 5xx to a visit (a wrong site id, domain or secret) logs one warning per provider and status a minute, naming the status and no URL, so lost stats show in the log.
- The visitor's address is sent only to a provider that needs it to tell visitors apart or place them: Plausible as `X-Forwarded-For`, Umami as `ip` in the payload, Matomo as `cip` with a `tokenAuth`, GA4 as `ip_override` and `custom` as `X-Forwarded-For`, the last two only with `address: true`; Simple Analytics not at all. It is the one `proxy` yields, so set `proxy` behind a CDN: without it every visitor shares the proxy's address, Plausible counts one visitor and the 120 a minute limit is shared by the whole site.

### Consent, legal basis and processors per provider

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

### Ask for analytics consent in your own UI

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

### Keep failed jobs for less time

A failed job keeps its payload, an address say, 30 days from when its last attempt was due; `keepFailed` shortens it and `redact` keeps less of it (kayjs-mail's queue does both by default):

```ts
import { queue } from 'kay/server'
import { sendMail } from './mail'

export const mail = queue('mail', sendMail, { keepFailed: '7d', redact: ({ to }) => ({ to, body: '' }) })
```

### Keep a photo's metadata

`files.put` drops what a camera writes in a JPEG, PNG or WebP, such as where the photo was taken; `keepMetadata` stores it as it came:

```ts
import { files } from 'kay/server'

export async function archive(scan: File) {
  return files.put(scan, { keepMetadata: true, private: true })
}
```

## Reference

### Cookies

- `session` (`__Host-session` over https): the session's sealed data or id, set once the app writes to a session; necessary, `maxAge` unused, `'30d'` by default, never past `absoluteMaxAge`, `'90d'`.
- `kay_flash`: the message an action's redirect shows on the next page, read once; necessary, 60 seconds.
- `kay_locale`: the locale a visitor picked, on a site with locales; necessary, a year. Named `kay-locale` before 1.52, which is still read.
- Under a `base`, `kay_flash` and `kay_locale` are set for that path alone, as `kay_preview` is.
- `kay_analytics`: the visitor's answer to the notice `analytics({ consent })` shows or to the information line of a counter that asks no one, `yes` or `no` (`no` is the opt-out); necessary to remember the choice, 180 days by default (`consent.maxAge`).
- `kay_preview`: preview mode for an editor, set only by `enterPreview`; necessary, `preview.maxAge`, an hour by default.
- Each `persisted(name, ...)` signal keeps its value in a cookie of that name for a year, or its `maxAge`, or in `localStorage` with `{ storage: 'local' }`; what it holds is the app's choice, so a preference is necessary and anything else waits for consent.

### What the server keeps

- Request logs carry the method, the path without its query string, the status, the duration and the request id: no address, no user agent, no cookie.
- `onError` gets the request whole, or `undefined` for an error met outside one; an error tracker is sent its path and id, not `request.url`, whose query may hold an address or a token.
- Sessions with a store live in it until they expire or `destroy()`; `sqliteStore` drops expired ones every hour and every 1000 writes, `memoryStore` every 1000 writes.
- `deleteWhere(match)` on `memoryStore()` and `sqliteStore(path)` deletes every session whose data `match` returns true for, resolving with how many went; an app's own store may offer it too, and sessions kept in the cookie alone cannot be listed, only waited out or ended for everyone by replacing the secret.
- Rate limits count by address in memory, or in `sqliteRates(path)`, which stores each key pseudonymised as an HMAC keyed by the session's, the app's (`secret`, `KAY_SECRET`) or the preview's secret once one is set, else by a random key kept in `<path>.key` beside the store (the server's user alone, shared by every process opening it), never in the store, so a copy of the store file alone cannot be checked against a guessed address; a backup of the whole folder holds both, so set a secret to keep the key off the disk; a window is dropped once it closed.
- A queue keeps a waiting job's payload until it runs and a failed one's for `keepFailed`, 30 days by default from when its last attempt was due, or for good with `false`.
- `queue.remove(id)` removes one job, and `queue.remove(match)` every waiting or failed job whose payload `match` returns true for, resolving with how many went; an app's own `JobStore` takes a function only when it has `jobs(queue)`.
- The paths a production server counted 404s at (`data/not-found.sqlite`) are forgotten 90 days after the last visit, with their referrers, checked on opening and at most hourly; the redirects stored beside them stay.
- `sqliteRooms` from `kay/server` keeps a room's messages 30 seconds, for the processes sharing it to read.
- The SQLite files `sqliteStore`, `sqliteRates`, `sqliteJobs`, `sqliteRooms` and `sqliteCache` create are readable by the server's user alone.

### Stored files

- `files.put` tells a JPEG, PNG, WebP, AVIF or HEIC by its bytes, whatever its name, and stores it with only what draws it: its pixels, colour profile and a JPEG's orientation, every other segment or chunk, EXIF, XMP, IPTC, C2PA, text and comments among them, dropped (an AVIF or HEIC has its non-picture items and boxes blanked in place); any other format is stored as it came, and a JPEG, PNG, WebP, AVIF or HEIC it cannot read through is refused with `image-invalid` unless `keepMetadata` is set.
- `files.delete(key)` deletes the file, its cached copy and every variant and social card the image route made of it.
- A photo of a person that only some visitors may see is stored with `private: true`, which only a link the page signed reaches.

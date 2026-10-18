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

- `provider` is `'plausible'` (`domain`, else the visited host), `'umami'` (`websiteId`), `'simpleanalytics'` (`hostname`, else the visited host) or `'matomo'` (`siteId`, `host`, optional `tokenAuth`); each but Matomo takes `host` for a self-hosted instance. All four are cookieless and take visits from the server, so they count at once. Matomo gets the visitor's address (`cip`) only with a `tokenAuth` of a user with write access, else it sees this server's.
- `'fathom'` (`siteId`, `spa`) and `'cloudflare'` (`token`) take data only from their own scripts (Cloudflare says so for its endpoint), so they are the exception to "through your origin": their script is added to the head and the CSP opened for their domains (`cdn.usefathom.com`; `static.cloudflareinsights.com` and `cloudflareinsights.com`). With `consent`, kay's script loads theirs after the yes, and a refusal after it loaded reloads the page without it.
- `'custom'` (`script`, `endpoint`, optional `address: true`) is any tracker that is a script posting to an endpoint: kay fetches `script` (an hour cached, 512 KB at most), serves it at `/_kay/analytics/script.js` with every `endpoint` written in it replaced by `/_kay/analytics/collect`, and passes what it posts to `endpoint`: a body of 64 KB at most, JSON, text or form content only, the visitor's `User-Agent` and, with `address: true`, `X-Forwarded-For`. The tracker counts page swaps itself, and the endpoint must appear in the script as written.
- GA4 is not offered: its Measurement Protocol asks for a secret and a client id the app would keep.
- The tracker is `/_kay/analytics.js`, added to every page's head, and counts the page on load and on each page swap (`kay:navigate`), the page the visitor left as referrer. Visits go to `POST /_kay/analytics` under the `base`.
- It needs a running server: `kay build --static` warns, since the exported pages would call a route that answers 404. Only `NODE_ENV=production` forwards; `kay dev` and tests answer the same and send nothing.
- A visit is answered at once and passed on in the background (200 waiting at most, then dropped).
- Add the optional `consent: true` (or `{ text, agree, refuse }`, each a string or one per language: `{ text: { en: 'Count?', fr: 'Compter ?' } }`) to wait for the visitor's yes: a notice kay builds (a labelled `section` at the end of the body, reached by Tab, focus never moved to it) asks until they choose, the answer is the `kay_analytics` cookie (`yes` or `no`, a year, `SameSite=Lax`, for the `base` path), and the server forwards nothing without `yes`, whatever the request claims.
- Any element with `data-analytics-consent` reopens the notice, so a visitor changes their mind as easily as they chose. `window.kayAnalytics.consent()` reads the answer (`'yes'`, `'no'` or `''`) and `kay:consent` fires on `document` when it changes.
- A visit is refused unless the page it names is on the host the request came to, or one in `hosts: ['www.example.com']`, which a proxy rewriting `Host` needs for the real one (a dropped visit logs a warning, once a minute at most); a body past 4 KB (413), a cross-site post (403) and more than 120 visits a minute from one address (429) are refused too.
- What a provider gets: the page URL without its hash and with only the `utm_*`, `ref` and `source` parameters of its query, the referrer without its query, the title, the screen size and language, and the visitor's `User-Agent`, cleaned of control characters. No cookie, `Referer` or `Authorization` of the visitor goes with it.
- The visitor's address is sent only to a provider that needs it to tell visitors apart: Plausible as `X-Forwarded-For`, Umami as `ip` in the payload, Simple Analytics not at all. It is the one `proxy` yields, so set `proxy` behind a CDN: without it every visitor shares the proxy's address, Plausible counts one visitor and the 120 a minute limit is shared by the whole site.

### Keep failed jobs for less time

A failed job keeps its payload, an address say, 30 days from when its last attempt was due; `keepFailed` shortens it:

```ts
import { queue } from 'kay/server'
import { sendMail } from './mail'

export const mail = queue('mail', sendMail, { keepFailed: '7d' })
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
- `kay_analytics`: the visitor's answer to the notice `analytics({ consent })` shows, `yes` or `no`; necessary to remember the choice, a year.
- `kay_preview`: preview mode for an editor, set only by `enterPreview`; necessary, `preview.maxAge`, an hour by default.
- Each `persisted(name, ...)` signal keeps its value in a cookie of that name for a year, or its `maxAge`, or in `localStorage` with `{ storage: 'local' }`; what it holds is the app's choice, so a preference is necessary and anything else waits for consent.

### What the server keeps

- Request logs carry the method, the path without its query string, the status, the duration and the request id: no address, no user agent, no cookie.
- `onError` gets the request whole, or `undefined` for an error met outside one; an error tracker is sent its path and id, not `request.url`, whose query may hold an address or a token.
- Sessions with a store live in it until they expire or `destroy()`; `sqliteStore` drops expired ones every hour and every 1000 writes, `memoryStore` every 1000 writes.
- `deleteWhere(match)` on `memoryStore()` and `sqliteStore(path)` deletes every session whose data `match` returns true for, resolving with how many went; an app's own store may offer it too, and sessions kept in the cookie alone cannot be listed, only waited out or ended for everyone by replacing the secret.
- Rate limits count by address in memory, or in `sqliteRates(path)`, which stores each key pseudonymised: hashed with a salt the file keeps, as an HMAC keyed by the session's, the app's (`secret`, `KAY_SECRET`) or the preview's secret once one is set, so the file alone cannot be checked against a guessed address; a window is dropped once it closed.
- A queue keeps a waiting job's payload until it runs and a failed one's for `keepFailed`, 30 days by default from when its last attempt was due, or for good with `false`.
- `queue.remove(id)` removes one job, and `queue.remove(match)` every waiting or failed job whose payload `match` returns true for, resolving with how many went; an app's own `JobStore` takes a function only when it has `jobs(queue)`.
- `sqliteRooms` from `kay/server` keeps a room's messages 30 seconds, for the processes sharing it to read.
- The SQLite files `sqliteStore`, `sqliteRates`, `sqliteJobs`, `sqliteRooms` and `sqliteCache` create are readable by the server's user alone.

### Stored files

- `files.put` tells a JPEG, PNG or WebP by its bytes, whatever its name, and stores it with only what draws it: its pixels, colour profile and a JPEG's orientation, every other segment or chunk, EXIF, XMP, IPTC, C2PA, text and comments among them, dropped; any other format, AVIF and HEIC included, and a file it cannot read through, logged, are stored as they came.
- `files.delete(key)` deletes the file, its cached copy and every variant and social card the image route made of it.
- A photo of a person that only some visitors may see is stored with `private: true`, which only a link the page signed reaches.

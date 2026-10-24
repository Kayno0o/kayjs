# Privacy and personal data

What kay keeps about visitors, where and for how long, and what an app calls to erase a person who asks, as the GDPR has it.

kay sets no cookie and stores nothing of a visitor until the app uses a feature that does, and none of what it keeps tracks a visitor across sites; the Reference lists each cookie, each storage key and what the server keeps, for the app to decide what its notice and consent need. Counting visits and Web Vitals is in [Analytics and Web Vitals](analytics.md).

## Common tasks

### Erase a person on request

Delete the app's own rows first, then the sessions and jobs kay keeps for them and the files they uploaded:

```ts
import { files, notifications, queue, sqliteStore } from 'kay/server'
import { db } from './db'
import { sendMail } from './mail'

// The file `store: sqliteData('data/app.sqlite')` names in kay.config.ts: sqliteStore of it is the store its sessions are in.
export const sessions = sqliteStore('data/app.sqlite')
export const mail = queue('mail', async (job: { userId: string, to: string, text: string }) => sendMail(job))

export async function erase(userId: string) {
  const user = await db.users.delete(userId)

  if (user.avatar !== undefined)
    await files.delete(user.avatar)

  await sessions.deleteWhere({ userId })
  await mail.remove(job => job.userId === userId)
  await notifications.erase(userId)
}
```

A site with a kayjs-mail mailing list also calls `await mail.erase(email)`: it takes the address off every list and removes the queued mails. With kayjs-auth, `deleteAccount` and `deleteUser` already call `notifications.erase` and `mail.erase` (for a verified address), and `exportData` lists both, so an app erasing through them adds neither.

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

- `kay_session` (`__Host-kay_session` over https): the session's sealed data or id, set once the app writes to a session; necessary, `maxAge` unused, `'30d'` by default, never past `absoluteMaxAge`, `'90d'`.
- `kay_flash`: the message an action's redirect shows on the next page, read once; necessary, 60 seconds. Over https `__Host-kay_flash`, and `__Secure-kay_flash` under a `base`; `kay_locale` and `kay_preview` go by the same rule.
- `kay_locale`: the locale a visitor picked, on a site with locales; necessary, a year. Named `kay-locale` before 1.52, which is still read.
- Under a `base`, `kay_flash` and `kay_locale` are set for that path alone, as `kay_preview` is.
- `kay_analytics`: the visitor's answer to the notice `analytics({ consent })` shows or to the information line of a counter that asks no one, `yes` or `no` (`no` is the opt-out); necessary to remember the choice, 180 days by default (`consent.maxAge`).
- `kay_preview`: preview mode for an editor, set only by `enterPreview`; necessary, `preview.maxAge`, an hour by default.
- `kay_preview_admitted`: set beside an edit-mode `kay_preview` once the cms guard admitted its holder, so presence shows editor names without asking the guard again; necessary, same lifetime and prefix rule as `kay_preview`.
- `kay_user` (kayjs-auth, also read by kayjs-cms): a random value, readable by scripts, set while a person is signed in so a library's script asks the server only for a browser that may get an answer; necessary, for the sign-in's `maxAge` or the browser session, ended at sign-out.
- `kay_editor` (kayjs-cms): marks the browser as an editor's, readable by scripts, so the Edit this page link looks for an answer; necessary, 90 days slid forward each time the guard lets the editor through, ended at sign-out.
- `kay_editor_who` (kayjs-cms): a digest naming which editor is signed in, readable by scripts, so the on-page editor keeps its drafts per person; necessary, 90 days, set when the guard lets the editor through, ended at sign-out.
- `kay_editor_session` (kayjs-cms `passwordGuard`): the password sign-in, `<role>.<expires>.<signature>`, `httpOnly`; necessary, `maxAge`, `'14d'` by default.
- `ksteps_<name>` (kayjs-ui `stepDraft`): the values of a multi-step form between its steps, `httpOnly`, up to 3,800 encoded bytes, what a visitor typed in; necessary for the form they are filling in, `maxAge` (a duration), an hour by default, ended by `clear()`.
- Each `persisted(name, ...)` signal keeps its value in a cookie of that name for a year, or its `maxAge`, or in `localStorage` with `{ storage: 'local' }`; what it holds is the app's choice, so a preference is necessary and anything else waits for consent.

### Browser storage

- `sessionStorage` `kay-reloaded`: the time of the last reload kay made for a page of an older build, so it never reloads twice within a minute; necessary, the tab's life, nothing personal.
- `sessionStorage` `kay_editor-refused` (kayjs-cms): the sign-in value the editor check refused, so a signed-in visitor who is no editor costs one request per tab; necessary, the tab's life.
- `localStorage` `kcms:draft:<entry>` (kayjs-cms): an editor's unsaved draft of an entry, whatever they typed; necessary for the editor who asked to keep it, a week, dropped once saved.
- `localStorage` under the name of a `persisted(name, ..., { storage: 'local' })` signal, as the cookies above.
- `localStorage` `kcms-editor` (kayjs-cms): where the editor's panel sits and how big it is; a preference, until the editor clears it.
- `localStorage` `kcms:rebuilding` (kayjs-cms): the time of a save the site is still rebuilding for, so the notice shows in every tab; necessary, dropped when the rebuild ends.
- `sessionStorage` under the `remember` key of kayjs-ai's `Chat` and `ChatLauncher` (none unless named): the conversation's text, up to 200,000 characters, what the visitor wrote included; the tab's life, nothing without `remember`.
- `localStorage` under the `listWidthKey` of kayjs-ui's `SplitLayout` (none unless named): the list's width, a preference.
- With `offline`, the service worker and its Cache Storage `kay-w<version>`: the pages `offline.pages` names (the public prerendered ones by default) and the files, and the public pages and files it fetched later that answered 200 without `private` or `no-store`; each copy changes with the build and the cache stays until `offline` is turned off or the worker's version changes. A page of `offline.pages` that holds a visitor's render is kept as it was served, so list only public ones.

### What the server keeps

- A `live()` value is the app's own data, kept in `store.live` for every visitor (the app must not put a person in it), and a presence `member` is whatever the page's server fence gave, a name say, kept in `store.rooms` while the tab is open and about 10 seconds after a crash.
- Request logs carry the method, the path without its query string, the status, the duration and the request id: no address, no user agent, no cookie.
- `onError` gets `{ error, request }`, the request whole, or `undefined` for an error met outside one; an error tracker is sent its path and id, not `request.url`, whose query may hold an address or a token.
- Sessions with a store live in it until they expire or `destroy()`; `sqliteStore` drops expired ones every hour and every 1000 writes, `memoryStore` every 1000 writes.
- `deleteWhere(match)` on `memoryStore()` and `sqliteStore(path)` deletes every session whose data `match` accepts (an object of fields held equal, `{ userId }`, which the SQLite and Postgres stores narrow in the database, or a function, read 500 sessions at a time; an empty object throws), resolving with how many went; an app's own store may offer it too, and sessions kept in the cookie alone cannot be listed, only waited out or ended for everyone by replacing the secret.
- Rate limits count by address in memory, or in `sqliteRates(path)`, which stores each key pseudonymised as an HMAC keyed by [the app secret](environment.md#the-app-secret) once one is set, else by a random key kept in `<path>.key` beside the store (the server's user alone, shared by every process opening it), never in the store, so a copy of the store file alone cannot be checked against a guessed address; a backup of the whole folder holds both, so set a secret to keep the key off the disk; a window is dropped once it closed.
- A queue keeps a waiting job's payload until it runs and a failed one's for `keepFailed`, 30 days by default from when its last attempt was due, or for good with `false`.
- `queue.remove(id)` removes one job, and `queue.remove(match)` every waiting or failed job whose payload `match` returns true for, resolving with how many went; an app's own `JobStore` takes a function only when it has `jobs(queue)`.
- kayjs-mail's mailing lists keep each subscriber's address, language, confirmation date and the proof of consent (the page of the form and the id of the notice it showed) in `data/mail-list.sqlite` until they unsubscribe or `mail.erase(address)` (which also removes the mails queued for it); an address nobody confirmed is dropped after 7 days, a broadcast and its deliveries (random ids, no address) 30 days after it finished.
- Notifications (`notify()`, [Notifications](notifications.md)) live 90 days, or the `keep` given, in `store.notifications` (memory without a store), the newest 200 per user; `notifications.erase(userId)` deletes a person's, and the devices they subscribed to push in `store.push` (`push()`, [Notifications](notifications.md#push-to-a-persons-devices)).
- The paths a production server counted 404s at (`data/not-found.sqlite`) are forgotten 90 days after the last visit, with their referrers, checked on opening and at most hourly; the redirects stored beside them stay.
- `sqliteRooms` from `kay/server` keeps a room's messages 30 seconds, for the processes sharing it to read.
- The SQLite files `sqliteStore`, `sqliteRates`, `sqliteJobs`, `sqliteRooms` and `sqliteCache` create are readable by the server's user alone, and `sqliteStore`, `sqliteRates` and `sqliteRooms` create theirs on first use, so loading a config that names one to build or check makes no file.

### Stored files

- `files.put` tells a JPEG, PNG, WebP, AVIF or HEIC by its bytes, whatever its name, and stores it with only what draws it: its pixels, colour profile and a JPEG's orientation, every other segment or chunk, EXIF, XMP, IPTC, C2PA, text and comments among them, dropped (an AVIF or HEIC has its non-picture items and boxes blanked in place); any other format is stored as it came, and a JPEG, PNG, WebP, AVIF or HEIC it cannot read through is refused with `image-invalid` unless `keepMetadata` is set.
- `files.delete(key)` deletes the file, its cached copy and every variant and social card the image route made of it.
- A photo of a person that only some visitors may see is stored with `private: true`, which only a link the page signed reaches.

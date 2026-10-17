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

### Load analytics only once the visitor agreed

An island keeps the answer in a persisted signal, loads the script once it is yes, and keeps a button that asks again, where refusing withdraws an earlier yes:

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
- `kay_preview`: preview mode for an editor, set only by `enterPreview`; necessary, `preview.maxAge`, an hour by default.
- Each `persisted(name, ...)` signal keeps its value in a cookie of that name for a year, or its `maxAge`, or in `localStorage` with `{ storage: 'local' }`; what it holds is the app's choice, so a preference is necessary and anything else waits for consent.

### What the server keeps

- Request logs carry the method, the path without its query string, the status, the duration and the request id: no address, no user agent, no cookie.
- `onError` gets the request whole; an error tracker is sent its path and id, not `request.url`, whose query may hold an address or a token.
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

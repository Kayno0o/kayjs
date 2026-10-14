---
title: Privacy
order: 9.5
description: What kay keeps about visitors and for how long, erasing a person who asks, analytics behind consent and photos without their metadata.
---

kay sets no cookie and keeps nothing about a visitor until the app uses a feature that does, and nothing it keeps follows a visitor across sites. This page lists what each feature keeps, for a site's privacy notice and for the app to decide what consent it needs, and how an app erases a person who asks, as the GDPR requires.

## Cookies

| Cookie | Set by | Kept |
| --- | --- | --- |
| `session`, `__Host-session` over https | a session the app writes to | 30 days unused, 90 at most, by default |
| `kay_flash` | an action redirecting with a flash message | 60 seconds |
| `kay-locale` | a visitor picking a locale | a year |
| `kay_preview` | `enterPreview()`, for an editor | an hour by default |
| the name given to `persisted()` | a persisted signal | a year |

The first four are necessary for what the visitor asked, so they need no consent. A persisted signal holds what the app puts in it: a theme or a language is necessary, anything else waits for consent.

## What the server keeps

- **Request logs**: method, path without its query string, status, duration and request id. No address, user agent or cookie.
- **Sessions** with a store: until they expire or the visitor signs out. `sqliteStore` drops expired ones every hour.
- **Rate limits**: counted by address in memory, or in `sqliteRates(path)` pseudonymised, a salted hash keyed by the session's or the preview's secret once one is set, and dropped once their window closes.
- **Jobs**: a waiting job's payload until it runs, a failed one's for 30 days from when its last attempt was due, or what the queue's `keepFailed` says.
- **Rooms**: a message 30 seconds in `sqliteRooms`.
- **Uploads**: until the app deletes them, without the metadata a camera writes in a JPEG, PNG or WebP.

Every SQLite file kay creates is readable by the server's user alone.

## Erasing a person

Delete the app's own rows, then what kay keeps for them:

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

`files.delete` also deletes every resized variant of the file and every social card drawn on it. Sessions kept in the cookie alone, without a store, cannot be listed: they end when they expire, or for everyone when the secret is replaced.

## Analytics behind consent

An island keeps the visitor's answer in a persisted signal and loads the script once it is yes. A button stays to ask again, and refusing after agreeing clears the script's cookie and reloads, so the visitor can withdraw as easily as they agreed:

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

`files.put` keeps only what draws a JPEG, PNG or WebP, told by its bytes whatever its name: its pixels, colour profile and orientation. The EXIF, XMP, IPTC and text a camera or phone writes, such as where and when the photo was taken, go, and so does any metadata kay does not know. An AVIF or HEIC is stored as it came, and so is a file kay cannot read through, which it logs. `files.put(file, { keepMetadata: true })` keeps everything, for an archive that needs it. A photo of a person that only some visitors may see is stored with `private: true`, served only through a link the page signed.

## Upgrading

A site that ran an older kay has four things to do or know:

- SQLite files created before keep their mode: `chmod 600` them.
- Image variants made before `files.delete` erased them stay in `.kay/cache/images` until it is emptied.
- The first start purges failed jobs past `keepFailed`, 30 days by default.
- Rate-limit counts start over on the first deploy with a session or preview secret, as keys are then hashed with it.

## Error trackers

`onError` gets the whole request. Send a tracker its path rather than `request.url`, whose query may hold an address or a token:

```ts
import { defineConfig, requestId } from 'kay/server'

export default defineConfig({
  onError: (error, request) => tracker.capture(error, { path: new URL(request.url).pathname, id: requestId(request) }),
})
```

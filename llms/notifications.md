# In-app notifications

A signed-in user's inbox: `notify(userId, ...)` on the server stores a notification, and the Bell of kayjs-ui shows the unread count and the list, updated in every open tab. Not mail or a toast: those have their own pages. A person who opted in also gets it as a web push, below.

## Common tasks

### Tell a user something happened

`notify(userId, { title, url })` stores a notification for that user, in an action, a job or a route; the id is whatever names the user, `user.id` of kayjs-auth say. There is no table to write:

```ts
import { notify } from 'kay/server'

export async function shipOrder(order: { id: string, userId: string }) {
  await notify(order.userId, { title: `Order ${order.id} shipped`, url: `/orders/${order.id}` })
}
```

### Show the Bell

`Bell` from kayjs-ui sits in a layout or a page, with no prop: it shows nothing to a visitor nobody is signed in as, and for a signed-in user a button with the unread count and a list that marks a notification read when it is opened, with "Mark all as read":

```kay
---
import Bell from '@kaynooo/kayjs-ui/bell.kay'
---
header
  nav
    Bell
```

### Keep notifications somewhere that outlives a restart

Without a store they live in the process's memory, as presence does. `store: sqliteData('data/app.sqlite')` keeps them in the `kay_notifications` table of that file, and `pgData(db)` in Postgres for replicas, both created on first use:

```ts
// kay.config.ts
import { defineConfig, sqliteData } from 'kay/server'

export default defineConfig({ store: sqliteData('data/app.sqlite') })
```

### Keep one for less or more than 90 days

A notification expires after 90 days; `keep` changes that for one:

```ts
import { notify } from 'kay/server'

await notify(userId, { title: 'Your export is ready', url: '/exports', keep: '7d' })
```

### Read or change an inbox from the server

`notifications` is the same inbox the Bell uses, for a page of your own or the function that erases a person ([Privacy](privacy.md#erase-a-person-on-request)):

```ts
import { notifications } from 'kay/server'

const newest = await notifications.list(userId, { limit: 5 })
const unread = await notifications.unread(userId)

await notifications.markAllRead(userId)
await notifications.erase(userId)
```

### Push to a person's devices

`push()` in the extensions turns on web push: kay keeps the subscriptions in the app's store, signs and encrypts each push, and adds the `push` and `notificationclick` handlers to its service worker, which it serves and registers on every page with or without `offline`. When the browser rotates a subscription the worker subscribes again with the served key and posts it to the subscribe route with the session cookie, so the person keeps their pushes without reopening the page (a person signed out by then is not re-subscribed; a worker that could not reach the server keeps the new subscription, and a page using `webPush` posts the one the browser holds on load when it differs from the last one the server accepted, kept in `localStorage`); an app that turns `offline` off while listing `push()` has the earlier worker's caches deleted. A person who subscribed gets every `notify()` as a push too, with no second call; `push: false` in its options keeps one in the inbox alone:

```ts
// kay.config.ts
import { defineConfig, push } from 'kay/server'

export default defineConfig({ extensions: [push({ subject: 'mailto:ops@example.com' })] })
```

`kay push keys` prints `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` for the production environment (`kay env` lists them as required there); under `kay dev` alone a pair is generated once into `.kay/vapid.json`, and a push endpoint on loopback is accepted (any other server, whatever its `NODE_ENV`, refuses both). `subject` is the contact push services reach you by, the https origin of `SITE_URL` when left out. List `push()` after the library that names the signed-in user (kayjs-auth), as the Bell needs.

`sendPush` sends a push alone, whatever the inbox holds:

```ts
import { sendPush } from 'kay/server'

const { sent, dropped, failed } = await sendPush(userId, { title: 'Order shipped', body: 'On its way', url: '/orders/12' }, { urgency: 'high', ttl: '1h' })
```

An island opts the visitor in from a click, and out again:

```kay
---
import { webPush } from 'kay'
---
button(onClick={async () => { await webPush.subscribe() }}) Notify me
```

`webPush.state()` is a signal to draw it from: `'unsupported'`, `'denied'`, `'off'` or `'subscribed'`. `subscribe()` asks the permission only while the page has a user gesture, so call it from a click; it answers `'subscribed'`, `'denied'`, `'off'` (the prompt was dismissed), `'needs-gesture'` (nothing asked), `'unsupported'`, `'signed-out'` or `'failed'`. `unsubscribe()` answers whether a device went. kayjs-auth's sign-out also drops the subscription this browser made for the person (a cookie of a hash names it), so a shared device stops getting their pushes while their other devices keep them; an auth of your own calls `forgetPushDevice(request, userId)` from `kay/server` when it ends a session. iOS shows pushes only for a site added to the home screen.

`installPrompt` from `kay` is the browser's offer to install the site: `installPrompt.available()` is a signal, true once the browser made the offer, and `await installPrompt.show()` (from a click) answers `'accepted'`, `'dismissed'` or `'unavailable'`. No config is needed: a page rendering an island that uses `installPrompt` carries a small inline script keeping the browser's offer from the first moment, before the island hydrates, and no other page does, except that a page with a streamed `await` block or deferred server island carries it whenever any island of the app uses `installPrompt` (holding it hides Chrome Android's own install bar). Safari never makes the offer.

## Reference

- `notify(userId, { title, url?, keep? })` answers the stored `Notification` (`id`, `title`, `url?`, `at` in milliseconds, `read`). `userId` is 1 to 200 characters and `title` 1 to 200 after trimming, a `RangeError` otherwise. The title is text: the Bell writes it as text, never as HTML.
- `url` is kept only as a path of the site (`/orders/12`, not `//host` nor `/\host`) or an absolute http(s) URL; any other, `javascript:` and `data:` included, is dropped with a warning and the notification kept without a link, and the link is checked again when it is read from the store and when the Bell draws it. A path is put under `base` and the locale as a link is, and an absolute URL opens in a new tab.
- `notifications.list(userId, { limit })` (20 by default, newest first), `.unread(userId)`, `.markRead(userId, id)` (false for an id the user does not have), `.markAllRead(userId)` and `.erase(userId)` (how many went) change one user's inbox only. `.inbox(userId)` is what the Bell reads: the unread count and the newest 20.
- Retention: 90 days from `notify`, or `keep` (a duration). An expired notification is never listed or counted, and is deleted when the store opens, on every `notify` and hourly (`sqliteData`, `pgData`). A user keeps their newest 200; older ones go as new ones come.
- The store is `store.notifications` of kay.config.ts: `sqliteData(path)` and `pgData(db)` fill it, `{ notifications }` takes a `NotificationStore` of your own (`add`, `list`, `unread`, `markRead`, `markAllRead`, `erase`, `prune`, each possibly answering with a promise). A `bun test` site keeps notifications in memory.
- The Bell asks `GET /_kay/ui/inbox` and posts `POST /_kay/ui/inbox/read` (`{ id }`, or `{}` for all), served by `ui()` of kayjs-ui under `base`. Who is asking is read from the request through the user the auth library names (kayjs-auth does), never from a parameter, so one user never reaches another's notifications, and a request nobody is signed in for gets 401.
- Live: the route reads the inbox as `cached(..., { live: true })` does, so every open tab updates within about a second of a `notify`, a read or an erase, in any process sharing a cache store; a hidden tab catches up when shown ([Following cached values](live-values.md#following-cached-values)). The inbox is cached in the process's memory only, never in the cache store.
- `Bell` takes `label` (the `ui.bell.label` message, "Notifications") and `placement`. A page with a Bell is the signed-in visitor's own: `private, no-cache` and rendered per request, as one reading `ctx` is. Put the Bell in a layout or a page, not inside an island: it reads the visitor on the server.
- Erasing a person: call `notifications.erase(userId)`, which also deletes their push subscriptions, with the rest of the function in [Privacy](privacy.md#erase-a-person-on-request).
- Push: `sendPush(userId, { title, body?, url?, tag?, icon? }, { ttl?, urgency?, topic? })` answers `{ sent, dropped, failed }`. Title is 1 to 200 characters, body up to 500, tag 64; `url` and `icon` are kept as `notify` keeps a link, and a path goes under `base` in the worker. The payload is RFC 8291 aes128gcm with a VAPID (RFC 8292) JWT, on Web Crypto with no dependency. A push service answering 404 or 410 deletes that subscription; any other refusal counts as `failed` and keeps it. A person keeps their newest 10 devices. `pushSubscriptions.list(userId)` and `.erase(userId)` read and delete them.
- Push store: `store.push` of kay.config.ts, a `PushStore` (`add`, `list`, `remove`, `erase`): `sqliteData` and `pgData` fill it (the `kay_push_subscriptions` table), memory otherwise.
- Push routes: `GET /_kay/push/key`, `POST /_kay/push/subscribe` and `/unsubscribe` (which ends the `kay_push_device` cookie), whose user comes from the request (401 when nobody is signed in) and which refuse another site; a subscription's endpoint must be https at a public address in production.

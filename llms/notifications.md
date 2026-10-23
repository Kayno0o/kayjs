# In-app notifications

A signed-in user's inbox: `notify(userId, ...)` on the server stores a notification, and the Bell of kayjs-ui shows the unread count and the list, updated in every open tab. Not mail, push or a toast: those have their own pages.

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

## Reference

- `notify(userId, { title, url?, keep? })` answers the stored `Notification` (`id`, `title`, `url?`, `at` in milliseconds, `read`). `userId` is 1 to 200 characters and `title` 1 to 200 after trimming, a `RangeError` otherwise. The title is text: the Bell writes it as text, never as HTML.
- `url` is kept only as a path of the site (`/orders/12`, not `//host` nor `/\host`) or an absolute http(s) URL; any other, `javascript:` and `data:` included, is dropped with a warning and the notification kept without a link, and the link is checked again when it is read from the store and when the Bell draws it. A path is put under `base` and the locale as a link is, and an absolute URL opens in a new tab.
- `notifications.list(userId, { limit })` (20 by default, newest first), `.unread(userId)`, `.markRead(userId, id)` (false for an id the user does not have), `.markAllRead(userId)` and `.erase(userId)` (how many went) change one user's inbox only. `.inbox(userId)` is what the Bell reads: the unread count and the newest 20.
- Retention: 90 days from `notify`, or `keep` (a duration). An expired notification is never listed or counted, and is deleted when the store opens, on every `notify` and hourly (`sqliteData`, `pgData`). A user keeps their newest 200; older ones go as new ones come.
- The store is `store.notifications` of kay.config.ts: `sqliteData(path)` and `pgData(db)` fill it, `{ notifications }` takes a `NotificationStore` of your own (`add`, `list`, `unread`, `markRead`, `markAllRead`, `erase`, `prune`, each possibly answering with a promise). A `bun test` site keeps notifications in memory.
- The Bell asks `GET /_kay/ui/inbox` and posts `POST /_kay/ui/inbox/read` (`{ id }`, or `{}` for all), served by `ui()` of kayjs-ui under `base`. Who is asking is read from the request through the user the auth library names (kayjs-auth does), never from a parameter, so one user never reaches another's notifications, and a request nobody is signed in for gets 401.
- Live: the route reads the inbox as `cached(..., { live: true })` does, so every open tab updates within about a second of a `notify`, a read or an erase, in any process sharing a cache store; a hidden tab catches up when shown ([Following cached values](live-values.md#following-cached-values)). The inbox is cached in the process's memory only, never in the cache store.
- `Bell` takes `label` (the `ui.bell.label` message, "Notifications") and `placement`. A page with a Bell is the signed-in visitor's own: `private, no-cache` and rendered per request, as one reading `ctx` is. Put the Bell in a layout or a page, not inside an island: it reads the visitor on the server.
- Erasing a person: call `notifications.erase(userId)` with the rest of the function in [Privacy](privacy.md#erase-a-person-on-request).

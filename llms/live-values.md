# Live values, cached values and presence

Keeping a value current on every open page, chat over a websocket, and following cached values and presence. Reading routes and streams from an island is in [Calling API routes from islands](api-from-islands.md).

## Common tasks

### Keep a value current on every open page

`live(initial)` in a module of the project is a value the server changes and every page reading it follows, with no API module, route or stream written:

```ts
// src/live.ts
import { live } from 'kay'

export const visitors = live(0)
export const room = live((id: string) => ({ id, users: 0 }))
```

```kay
---
import { room, visitors } from '../live'

const { id } = props<{ id: string }>()
---
p {visitors()} online, {room(id).users} in {id}
```

```ts
// an action, a job, a route or a server fence
visitors.set(n => n + 1)
room.set('lobby', { id: 'lobby', users: 3 })
```

- Read by calling it, in a template or an island, as a signal is; `room(id)` reads one key. A component reading one is an island, so a page reading none ships no JS and opens no connection.
- Written with `set` on the server only: a `.set` or `.delete` outside a server fence is a compile error, an assignment too, and in a browser it throws.
- Declare it as `export const name = live(...)` at the top of a module; the build names it from its path, so the server and the browser agree.

### Chat over a websocket

`socket(module, path, options)` opens a websocket route of a module, and `send` takes the route's `body`:

```kay
---
import { socket } from 'kay'
import chat from '../api/chat'

const { room } = props<{ room: string }>()
const messages = socket(chat, '/:room', { params: { room } })
const text = signal('')
---
p {messages.status()}
p {messages.last()?.text}
input(bind:value={text})
button(onClick={() => messages.send({ text: text() })}) Send
```

On an `api()` chain only, a message failing `body` is dropped, with no reply or `onError` (logged under `kay dev`); a valid one is decoded as an HTTP body is, extra keys stripped.

## Reference

### Live values

- `live(initial)` is a `Live<T>`: `value()` reads, `value.set(next | updater)` writes; `live(key => initial)` is `LiveByKey`: `value(key)`, `value.set(key, next)`, `value.delete(key)`. A key is a string, a key nothing was set for reads what the function gives, and `delete` puts it back.
- A value must cross to the browser as island props do (Dates, Maps and Sets included); a function, class instance or other unsendable value throws where it is set, naming the constant and its id. A `set` to the value it holds sends nothing.
- A page's HTML holds the values it read, so an island hydrates with them and follows from there. One connection per page, `POST /_kay/live` (under `base`), carries every live value the page's islands read, and none opens when they read none; a swap to another page keeps it, moving it to the keys the new page reads, and closes it when none is read. Changes of one tick are sent as one event.
- A hidden tab closes the live-values connection and stops renewing its proof (unless it follows a presence key, below), and a tab shown again opens one that starts with every watched value as it is then; a page loaded in a hidden tab connects when it is shown. The connections of `socket()` and `stream()` are the app's and stay open.
- The server sends a value only to a request holding the signed proof of a page that read that key of it, so whoever can render the page can follow exactly what it read and a guard on the page covers it; whatever a render reads, its server fence included, goes into the page. Per-user scoping is not in v1: a value is the same for everyone who can render it.
- A page with a server fence, a layout and a special page render once and are no islands: reading a live value in their template is an error, so read it in a component. The fence may read and write it.
- A page reading a live value is rendered per request: `kay build` skips keeping it, and `prerender` or a static export of it fails with `export-server-render`.
- Replicas and restarts: `store: sqliteData(path)` in kay.config.ts (or `store: { live: sqliteLive(path) }`) keeps every `live()` value in the file, and `pgData(db)` in the `kay_live` table of Postgres for replicas on several machines, heard by polling within about half a second; so a `set` in one process reaches the tabs connected to another within about half a second, and a process starting reads what the store holds (a server at its start, never `kay build --static` nor `kay check`, so those need no database). Without a store the values live in one process's memory; a `bun test` site keeps them there too. Values are written as island props are, so a `Date` comes back a `Date`. A `set` reads this process's copy, up to half a second behind the store: an updater in two processes at once can lose one change, and a `set` of the value this process shows is skipped even when another process set a newer one, so set the value you mean. Another store implements `LiveStore` (`entries`, `set`, `delete`, `subscribe`, and `stop` when it polls); over a network `entries` answers with a promise the server waits for before serving, and `set` and `delete` answer with promises that must not reject (a failure is logged), written in the order they were made while `live.set` stays synchronous.
- Limits: keyed entries stay until `delete`; a proof lasts an hour, signed with `KAY_SECRET` or a key made at start-up; an open page asks for its own page again every half hour, and at once when a proof is refused with a 403 (a restart without `KAY_SECRET`), taking the fresh proofs; that renders the page again, so a server fence with side effects runs again, and a page that no longer holds a live value (a visitor who may not see it) is asked again only every five minutes; so one who may no longer see the page stops following within the hour; a dropped or refused connection (429, 5xx) is retried with a growing delay, not while the tab is hidden; one client, by `clientAddress()`, holds at most 20 live connections and opens 120 a minute, which `live: { connections, perMinute }` in kay.config.ts changes, so behind a reverse proxy set `proxy` in kay.config.ts or every visitor shares one address and one cap; a live value an island imports is proven by every page rendering the island (a `--- client` island included), so one read behind a click or in the browser only is followed; a keyed value read only after the render is not, as its key is not known before, so read it in the template.

### Following cached values

- `cached(key, ttl, load, { live: true })` makes every page that read the key in its render follow it: once `invalidate` drops the key, or a key its `load` read (a collection, another `cached`), each open tab shows the page as its loads give it now, with no island, route or socket written. Read it in the page's or a layout's server fence; a read after the document went out (an `await` block's) or in an API route is not followed.
- The server pushes no value, only that the key changed: the tab runs `refresh()`, so the page is rendered again for that visitor, and a guard, a per-visitor branch, the locale and `base` apply as for any visit. A `persist` island is given the new props and keeps its state; any other island whose props changed hydrates afresh, as after an action.
- The page carries its `data-kay-live` script with `[kay:cache, key, readAt]` per followed key, covered by the same signed proof, and the entry script loads the `live-cache` chunk only then. `POST /_kay/live` first sends the time each key was last invalidated (0 when never), then one event per invalidation, as often as it happens; a tab refreshes when that time is at or after its page's read, both from the server's clock, so an invalidation between render and connect, or during a dropped connection, is not missed. A page reading no such key opens no connection and loads no code for it.
- A refresh waits a random 0 to 750 ms so tabs do not render together, waits while the tab is hidden and runs once it is shown, and one in flight absorbs the events meanwhile. A dropped connection reconnects with a growing delay, not while the tab is hidden; a 403 (a proof an hour old, a restart without `KAY_SECRET`, or any followed key whose proof is out of date) refreshes the page and every followed route for new ones. With `navigation: false` the page reloads instead, unless a `guardLeave` holds changes.
- Several processes sharing a `sqliteCache`, the one `store: sqliteData(path)` gives included, or the Postgres one of `pgData(db)` ([Jobs](queues.md)), follow each other's `invalidate` (heard within about half a second); with no shared store a process hears its own only. A key expiring by `ttl` refreshes in the background without telling tabs: only `invalidate` pushes.
- The connection is the one route live values use but a reader of its own, so a page with both holds two connections of the client's cap. A key is at most 256 characters and a page follows at most 100 keys (a `RangeError` where `cached` is called). A page reading such a key is rendered per request, like one reading a live value: `kay build` keeps no file of it and a static export fails with `export-server-render`.
- A `resource(module, path)` follows the same keys with nothing written: a GET route whose handler reads a `cached(..., { live: true })` key answers with the header `x-kay-live`, the signed proof of the keys it read, and the `resource()` asks the route again after an `invalidate` of one, keeping `value()` and without turning `status()` to `loading`. A route that read no such key sends no header and its resource opens nothing. Only the answer of a handler that returned (not a thrown error, a `status()` refusal or a guard's) carries a proof, so a visitor gets the keys their own request read; a route follows keys up to about 4,000 bytes together, each counting its URL-encoded length and 50 bytes more, as the proof travels in a header (a `RangeError` where `cached` is called); the answer of a `status(201, ...)` or a `Response` of the route's own carries it too; a status set by name (`'Bad Request'`) counts as its code; the quiet refetch skips the browser's cache and, if it fails, keeps `value()` and `status()`, so a route failing for good (a 404 after its row was deleted) still shows the old value. `call()`, `stream()` and the function form of `resource()` do not follow.
- A collection with `live: true` ([content](content.md)) is followed the same way by a page that reads it directly, with no `cached` around it: its key is `kay:content:<name>`, which `posts.invalidate()` and a CMS save drop.
### Presence

- `presence(room, member)` from `kay` in an island lists who else has a room open, with no route, socket or store line: `const here = presence(`entry:${entry.id}`, me)`, then `here.others()` (the distinct members besides the visitor's own, in join order, so their other tabs are left out) and `here.count()` (the other tabs in the room, the visitor's own included) are reactive. `presence()` is the page's own room, its path under `base` without a trailing slash (a locale prefix stays), with an anonymous member: `count()` is the other tabs on the page.
- `member` is any value that crosses as island props do, compared as JSON; hand it in from the page's server fence (`me={{ name: user.name }}`), so what a visitor is listed as is what the server gave. Room and member are at most 256 characters together as JSON, a `RangeError` where `presence` is called (a long path included, for `presence()`).
- The island's server render notes them as a keyed live read of `kay:presence`, so the page's signed proof covers exactly them: a room or member the render did not note, forged or edited in the browser, or an expired proof, gets a 403 and joins nothing, and a guard on the page covers who sees the members. Like any live read the page renders per request (`export-server-render` on a static export) with the members as they stood, and a `--- client` island notes nothing, so has no presence.
- A tab joins when its live connection opens (`POST /_kay/live` first sends the room's members besides its own, then a changed list on each join and leave) and leaves when it ends: tab closed, page swapped to one without the room, connection dropped (a dead socket is found by the 5 second heartbeat) or the proof's hour out. A leave waits 3 seconds and a tab keeps one id across its connections, so a reconnect, a proof renewal or a swap to the same room shows the others no leave.
- A hidden tab keeps its connection, and stays listed, while it follows a presence key, renewing its proof; live values on that connection keep following too. A page loaded in a hidden tab joins at once.
- Members are kept in `store.rooms` of kay.config.ts, which `sqliteData(path)` holds, so replicas sharing a store share presence with no new line (`pgData(db)` does it over Postgres, a member of another replica listed within a poll); one process's memory otherwise. A join or leave reaches the other processes' streams as the store changes, a room is read again every 5 seconds, and a crashed process's members go after about 10 ([Rooms](rooms.md)). One member per open tab, so call `presence` once per room on a page; a page with no presence costs nothing, and a room of many tabs sends each the whole list on every join and leave.
- Not in v1: what each member is editing (a cursor, a field), and rooms outside a page, such as an API route's.

Rooms of connections, with their state, are in [Rooms](rooms.md).

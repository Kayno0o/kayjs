# Island sources: loading, failure and retry

Everything an island reads from the server, a `resource`, a `stream`, a `socket`, a `track()` handle, a `local` collection, a `live()` value, `navigation` and kayjs-ui's `infiniteList`, answers loading, failure and retry the same way. This page describes that shape once; the topic files say what each source reads. [Calling API routes from islands](api-from-islands.md), [Calling actions from islands](actions-from-islands.md), [Live values](live-values.md) and [Local collections](local-collections.md) link here.

## Common tasks

### Show any source's data, loading, failure and retry

Every source has `data()`, `status()`, `pending()`, `error()` and `retry()`, and tells them with `onData` and `onError` (the `Reader` type from `kay`; a `live()` value is the value itself and has no `data()`, and `onData` tells its changes):

- `data()` is what it read last, `undefined` before the first: a `resource`'s answer, a stream's or a socket's last value, a collection's rows, what the last call of a `track()` handle succeeded with, what an action's last call returned. It is kept while the source reads again or fails, but an action's `data()` is the outcome of its last call, so it is empty while a later call is in flight or after one failed.
- `status()` says where it stands. A value read once is a `LoadStatus`: `idle`, `loading`, `ready` or `failed`, for a `resource`, a `track()` handle, an action and a `local` collection alike. A connection is a `ConnectionStatus`: `idle`, `connecting`, `open`, `done`, `failed` or `closed`, for a stream, a socket and a `live()` handle.
- `pending()` is a boolean: whether it is loading or connecting, a quiet reload that keeps `ready` and the wait before a reconnect included.
- `error()` is the last failure as an `ApiError`, kept until the next success. On the server `error()` is `undefined`, `pending()` false and `retry()` does nothing.
- A `resource` reads once and asks again only for `refresh()`, a changed option, an invalidation of a key its route read with `live: true`, a key named in its `tags` that a call of the page invalidated, and the `revalidate` triggers it is given (`focus`, `reconnect`, an interval): none is the default, `stale` is 0.
- `retry()` tries again now, skipping any backoff. It does nothing unless the source failed or waits to try again, and after the component is gone. `resource.refresh()` is the one that asks again even when ready.

One block shows any source:

```kay
---
import { resource } from 'kay'
import notes from '../api/notes'

const list = resource(notes, '/')
---
if list.error() then error
  p {error.message}
  button(onClick={list.retry} disabled={list.pending()}) Retry
else
  p {list.data()?.length} notes
```

`retry` and the other methods are plain functions, so `onClick={list.retry}` needs no arrow.

## Reference

### One failure

A failure is an `ApiError` from `kay` whatever raised it: `status`, `message`, `errors` (a message per field) and `data` (the server's answer, typed for an action by `add.refused`). `message` is always the text to show. A route's refusal keeps its status; a failure with no answer (a network error, a function that threw, a timeout) is status 0. An `ActionError` is an `ApiError`, and a `track()` result that is not `ok` carries the same four fields, with the error itself as `error`.

### Which source has what

| Source | `data()` | `status()` values | Hooks |
| --- | --- | --- | --- |
| `resource` | the last answer | `loading`, `ready`, `failed` | `onData`, `onError` |
| `stream`, an action's stream | the last value | `idle`, `connecting`, `open`, `done`, `failed`, `closed` | `onOpen`, `onData`, `onError`, `onClose` |
| `socket` | the last message | as a stream | `onOpen`, `onData`, `onError`, `onClose` |
| `track()`, `call.track` | what the last success answered | `idle`, `loading`, `ready`, `failed` | `onData`, `onError` |
| an action | what the last call or form post returned | `idle`, `loading`, `ready`, `failed` | `onStart`, `onData`, `onError` for its form posts in place, see `track()` for its calls |
| `local` | the rows held | `loading`, `ready`, `failed` | `onData`, `onIssue`, `onError` |
| `live()` handle | none, the value is the handle | `idle`, `connecting`, `open`, `failed` | `onData`, `onError` |
| `navigation` | none | `idle`, `loading`, `swapping` | `navigation.onStart`, `onNavigate`, `onError`, `onStall`, `onBeforeNavigate` |
| `infiniteList` (kayjs-ui) | the rows loaded | `loading`, `ready`, `failed` | `load` and `onError` props, see kayjs-ui `infiniteList` |

- `local` reads `loading` until the browser's copy is read, then `ready`, or `failed` while `error()` is set (a read of the server failed, or the browser keeps no IndexedDB); `pending()` is true while it loads. What a collection has more is its sync with the server, under `sync`: `sync.status()` reads `loading`, `synced`, `unsynced`, `offline`, `signed-out` or `unavailable`, `sync.queued()` the count of writes the server has not taken, and `sync()` sends the queue and reads again ([Local collections](local-collections.md)).
- A `live()` handle reads the page's one connection, shared by every live value: `idle` while no island reads one and on the server, `connecting` while it is made or waits (a refused connection keeps retrying, with `error()` set), `failed` after an `error` event. Its `onData({ value })` (`{ value, key }` for a keyed value) is told each value the connection delivers and its `onError({ error })` each attempt that failed, in a browser; a render tells neither ([live values](live-values.md)).
- A stream or a socket fails on a refusal, an `error` event, a close with a code from 4000 to 4999 (`error().status` is the code minus 4000) or a source that threw. Any other drop reconnects with a backoff that sleeps while the page is hidden or offline. A socket is never `idle`.
- A stream and a socket also have `on(listener)` and `close()`; a stream has `start()` and `ended()`.
- A `track()` handle's `onData({ value, input })` is told each success, `value` what the call answered and `input` what it was given. An action's `data()` and `status()` read the outcome of its last call, or of the form post a page rendered for, on the server too.

### Hooks

A hook is an option of the source and a method of the same name, takes one object, and a method returns what removes the listener. An option and a method both run. A hook that throws is logged and leaves the source alone, and the server render calls none ([hooks](hooks.md)).

- `onOpen({ reconnected })`: the connection opened, `reconnected` true after the first open, a `retry()` included.
- `onData({ value })`: a value arrived, or a resource answered (a quiet reload and `mutate()` included, not the `initial` or server-rendered value), or a collection took the server's rows in or sent its queue. A `track()` handle's event also has `input`.
- `onError({ error })`: it failed, once per failure; never for a drop it reconnects from, an abort or a redirect. Runs before `onClose`. On a `track()` handle the event also has `input`.
- `onClose({ status })`: a run ended, once, as `done`, `failed` or `closed`; a restarted run fires again.
- `onIssue({ issue })` on a `local` collection: a write the server did not take as it was.

`socket(chat, '/:room', { params, onData: ({ value }) => add(value), onError: ({ error }) => toast.error(error.message) })` takes them as options; `messages.onClose(({ status }) => ...)` adds one later.

The names before 1.105 work until 1.108 and `kay check` rewrites them (`deprecated-source-readers`): `value()` of a `resource`, `last()` of a stream or a socket, `rows()` of a collection, `onSuccess({ data })` of a `track()` handle and `onSync({ rows })` of a collection, whose events hand `value` now, `unsynced()` and `syncStatus()` (`sync.queued()` and `sync.status()`), and an action's `succeeded()` (`data()` and `status()`).

### kayjs-ui components

`Notice(source={list})` shows `list.error()` while it is set, says its message, and has a retry button calling `list.retry` that is disabled while `list.pending()`. `LoadMore(list={people})` takes an `infiniteList` or any object with `data`, `ended` and `more` that is a Source. Both take a `resource`, `stream`, `track()` handle, `local` or `infiniteList` as they are, so an app wires no state between them (kayjs-ui's `Notice` and `infiniteList` pages).

# Island sources: loading, failure and retry

Everything an island reads from the server, a `resource`, a `stream`, a `socket`, a `track()` handle, a `local` collection, a `live()` value, `navigation` and kayjs-ui's `infiniteList`, answers loading, failure and retry the same way. This page describes that shape once; the topic files say what each source reads. [Calling API routes from islands](api-from-islands.md), [Calling actions from islands](actions-from-islands.md), [Live values](live-values.md) and [Local collections](local-collections.md) link here.

## The four questions

Every source has `status()`, `pending()`, `error()` and `retry()` (the `Source` type from `kay`):

- `status()` says where it stands. A value read once is a `LoadStatus`: `idle`, `loading`, `ready` or `failed`. A connection is a `ConnectionStatus`: `idle`, `connecting`, `open`, `done`, `failed` or `closed`.
- `pending()` is a boolean: whether it is loading or connecting, a quiet reload that keeps `ready` and the wait before a reconnect included.
- `error()` is the last failure as an `ApiError`, kept until the next success. On the server `error()` is `undefined`, `pending()` false and `retry()` does nothing.
- `retry()` tries again now, skipping any backoff. It does nothing unless the source failed or waits to try again, and after the component is gone. `resource.refresh()` is the one that asks again even when ready.

One block shows any source:

```kay
---
import { resource } from 'kay'
import notes from '../api/notes'

const list = resource(notes, '/')
---
if list.error() as error
  p {error.message}
  button(onClick={list.retry} disabled={list.pending()}) Retry
```

`retry` and the other methods are plain functions, so `onClick={list.retry}` needs no arrow.

## One failure

A failure is an `ApiError` from `kay` whatever raised it: `status`, `message`, `errors` (a message per field) and `data` (the server's answer, typed for an action by `add.refused`). `message` is always the text to show. A route's refusal keeps its status; a failure with no answer (a network error, a function that threw, a timeout) is status 0. An `ActionError` is an `ApiError`, and a `track()` result that is not `ok` carries the same four fields, with the error itself as `error`.

## Which source has what

| Source | `status()` values | Hooks |
| --- | --- | --- |
| `resource` | `loading`, `ready`, `failed` | `onData`, `onError` |
| `stream`, an action's stream | `idle`, `connecting`, `open`, `done`, `failed`, `closed` | `onOpen`, `onData`, `onError`, `onClose` |
| `socket` | `connecting`, `open`, `failed`, `closed` | `onOpen`, `onData`, `onError`, `onClose` |
| `track()`, `call.track` | `idle`, `loading`, `ready`, `failed` | `onSuccess`, `onError` |
| `local` | `syncStatus()` reads `loading`, `synced`, `unsynced`, `offline`, `signed-out`, `unavailable` | `onSync`, `onIssue`, `onError` |
| `live()` handle | `idle`, `connecting`, `open`, `failed` | none |
| `navigation` | `idle`, `loading`, `swapping` | `onNavigate`, `onBeforeNavigate` |
| `infiniteList` (kayjs-ui) | `loading`, `ready`, `failed` | `load` and `onError` props, see kayjs-ui `infiniteList` |

- `local` keeps its own words in `status()` until 2.0 (`pending` for `unsynced`), and its `pending()` still counts the writes the server has not taken until then: read `unsynced()` for that count and `syncStatus()` for the states. `error()` is set when a read of the server failed or the browser keeps no IndexedDB.
- A `live()` handle reads the page's one connection, shared by every live value: `idle` while no island reads one and on the server, `connecting` while it is made or waits (a refused connection keeps retrying, with `error()` set), `failed` after an `error` event.
- A stream or a socket fails on a refusal, an `error` event, a close with a code from 4000 to 4999 (`error().status` is the code minus 4000) or a source that threw. Any other drop reconnects with a backoff that sleeps while the page is hidden or offline.
- A stream and a socket also have `last()`, `on(listener)` and `close()`; a stream has `start()` and `ended()`.

## Hooks

A hook is an option of the source and a method of the same name, takes one object, and a method returns what removes the listener. An option and a method both run. A hook that throws is logged and leaves the source alone, and the server render calls none ([hooks](hooks.md)).

- `onOpen({ reconnected })`: the connection opened, `reconnected` true after the first open, a `retry()` included.
- `onData({ value })`: a value arrived, or a resource answered (a quiet reload and `mutate()` included, not the `initial` or server-rendered value).
- `onError({ error })`: it failed, once per failure; never for a drop it reconnects from, an abort or a redirect. Runs before `onClose`.
- `onClose({ status })`: a run ended, once, as `done`, `failed` or `closed`; a restarted run fires again.
- `onSuccess({ data, input })` and `onError({ error, input })` on a `track()` handle, `input` being what the call was given.
- `onSync({ rows })`, `onIssue({ issue })` and `onError({ error })` on a `local` collection.

`socket(chat, '/:room', { params, onData: ({ value }) => add(value), onError: ({ error }) => toast.error(error.message) })` takes them as options; `messages.onClose(({ status }) => ...)` adds one later.

## kayjs-ui components

`Notice(source={list})` shows `list.error()` while it is set, says its message, and has a retry button calling `list.retry` that is disabled while `list.pending()`. `LoadMore(list={people})` takes an `infiniteList` or any object with `rows`, `ended` and `more` that is a Source. Both take a `resource`, `stream`, `track()` handle, `local` or `infiniteList` as they are, so an app wires no state between them (kayjs-ui's `Notice` and `infiniteList` pages).

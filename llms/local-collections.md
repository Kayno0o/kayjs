# Local collections: reading and writing offline

`local()` from `kay` keeps a collection of rows in the browser, so an island reads and writes it at once, offline too, and the writes reach the server through the collection's own actions when it can be reached.

## Common tasks

### Write a collection that works offline

Declare the actions as for any call, one that stores a row and one that removes it, and a route that lists the rows:

```kay
--- server
import { action, s } from 'kay'
import { removeTodo, saveTodo } from '../data'

export const save = action(s.Object({ id: s.String({ maxLength: 40 }), title: s.String({ minLength: 1, maxLength: 200 }), rev: s.Number() }), async (todo, ctx) => {
  const held = await saveTodo(todo)

  return held.conflict ? ctx.fail(409, held.row) : held.row
})
export const remove = action(s.Object({ id: s.String({ maxLength: 40 }) }), async ({ id }) => removeTodo(id))
---
Todos
```

The island names them once:

```kay
---
import { call, local } from 'kay'
import { remove, save } from '../routes/todos.kay'
import todosApi from '../api/todos'

const todos = local({ key: 'id', read: async () => call(todosApi, '/'), put: save, remove })
---
p {todos.status()}
ul
  for todo of todos.rows()
    li {todo.title}
button(onClick={() => todos.put({ id: crypto.randomUUID(), title: 'New', rev: 0 })}) Add
```

`todos.put(row)` and `todos.remove(key)` change `todos.rows()` at once and resolve when the browser holds the change. Nothing else is declared: the row type is the `put` action's input.

### Decide a conflict

An action answers `ctx.fail(409, row)` with the row the server holds when a write started from an older one. The default keeps the server's row and puts the fields this write changed on it, then sends that; `conflict` replaces it, and returning `undefined` takes the server's row as it is:

```kay
---
import { local } from 'kay'
import { save } from '../routes/todos.kay'

const todos = local({ key: 'id', read: async () => [], put: save, conflict: ({ mine, theirs }) => mine === undefined || mine.rev > theirs.rev ? mine : undefined })
---
for issue of todos.issues()
  p {issue.kind} {issue.key}
```

## Reference

### What a collection is

- `local({ key, read, put, remove?, version?, conflict? })` returns `rows()`, `get(key)`, `put(row)`, `remove(key)`, `pending()`, `status()`, `issues()`, `dismiss(id)`, `sync()` and `clear()`. `rows()`, `pending()`, `status()` and `issues()` are reactive; the rows come in key order.
- `key` names the field identifying a row, a string or a number. `put` is an action taking the row, `remove` an action taking `{ [key]: value }`, and `read` a function giving the server's rows (`call` or `resource`'s route, or any promise): all three are the app's own, so their guards, schemas, rate limits and cross-site checks apply as to any call.
- The collection is named by its `put` action's URL, so declare it once per action; two islands declaring it share one mirror.
- On the server, and in a browser without IndexedDB, `local()` gives an empty collection: `status()` is `'loading'` on the server and `'unavailable'` where the browser keeps nothing, and a write there throws. Nothing loads on a page that does not import it.

### The mirror

- Rows live in the `kay-local` IndexedDB database of the site: the rows as they stand here, the row the server last gave for each (the base of a conflict), the queue of writes and the issues. The island reads and writes it before any request; `read` runs while online, after the queue was sent and on `sync()`, and a row the server no longer lists and nothing queued here wrote is dropped.
- A row crosses as island props do (Dates, Maps and Sets included) and holds no file.
- `version: 2` forgets the rows held (they are read again) and keeps the queue; use it when the rows' shape changes. The database itself is versioned by kay.
- Tabs share it: a change in one reaches the others through a `BroadcastChannel`, and a lock lets one tab or the worker send the queue at a time.
- `status()` is `'loading'` until the mirror is read, `'synced'`, `'pending'` (writes wait for the server), `'offline'` (the last attempt found no connection) or `'signed-out'` (the server answered 401 or sent the visitor to sign in: the queue waits, nothing is lost).

### Sending writes

- A write is queued with an id and sent in order, as the action's own call would be, with the id in an `x-kay-write` header: the server runs the action once per id and answers a retry with the first answer (a success or a refusal that will not change; not a 5xx, a 401, a 403, a 408, a 425 or a 429), kept a week in `store.cache` when the app has one and in the process otherwise. Any action honours the header, so a write lost on the way back is never applied twice.
- It is sent when the page loads, when the browser comes back online, when a tab becomes visible, after `put` and `remove`, and with growing delays while the connection fails. With the offline worker on (`offline` or `push()`), kay also asks the browser for background sync, so Chromium sends the queue with every tab closed; the worker records each answer for the page to apply when it next opens. Elsewhere the page sends it.
- An action returning the row it stored, with fields the server set, has it taken as both the base and the row shown.
- A network error, a 408, 425 or 429 and a 5xx keep the write queued and retried with growing delays; a write answered 5xx five times is rejected like a refusal, so one that always throws does not hold the queue. A 401, or a redirect to sign in, pauses the queue.
- A 2xx settles the write. A 409 carrying a row is a conflict (below). Any other answer, the schema's 400 or 422, a guard's 403, a 404, rejects the write (as does that fifth 5xx): it leaves the queue, the row goes back to the server's last version (or disappears, for a row the server never had), and `issues()` lists `{ id, kind: 'rejected', key, op, status, errors, data, mine }`, `errors` per field as an `ActionError` has them. `dismiss(id)` removes an issue.
- A conflict is settled by `conflict({ key, base, mine, theirs })`: `base` is the server's row this browser last saw (undefined for a row made here), `mine` the row of the write (undefined for a removal), `theirs` the row in the 409. The default merges, `theirs` with each field `mine` changed from `base`, and a removal gives way to the server's row; for a row made here (no `base`) it sends `mine` whole, which an action guarding a revision refuses again, so give `conflict` a rule for it. A row other than `theirs` is sent again as a new write, up to three times, then the write is rejected. The issue is `{ kind: 'conflict', key, op, mine, theirs, kept }`, `kept` the row now shown (undefined when it is the server's own).
- An action that never answers 409 makes the last write sent win.

### Signing out

- The mirror holds a person's rows, so a sign-out must empty it. The `kay_local_clear` cookie is how: `forgetLocalMirrors(request)` from `kay/server` gives the `Set-Cookie` value to add to the sign-out response, and the next page using a collection, offline too, forgets every row, queued write and issue of the browser before it reads. The worker's background sync drops a queued write made before the cookie changed (Chromium reads it with `cookieStore`) instead of sending it. Your sign-out adds the cookie itself, as in `headers.append('set-cookie', forgetLocalMirrors(request))`; kayjs-auth does not yet. The cookie lasts a year, and one that expired changes nothing. `todos.clear()` does it for one collection at once.
- The queue goes with the mirror: writes not yet sent when someone signs out are discarded, not sent as the next person.

### Not covered

- Following another browser's changes as they happen: call `sync()`, or combine with `live()` or `resource()`.
- Files in rows, a write sent to an action behind `proofOfWork`, and a stream: the call is made as `encodeCall` would, without them.
- Background sync is Chromium's; elsewhere the queue waits for the page.

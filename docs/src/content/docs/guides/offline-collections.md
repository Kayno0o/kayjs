---
title: Collections that work offline
order: 6.6
description: Keep rows in the browser so an island reads and writes them with no connection, and send the writes when it returns.
---

An island that writes through an action fails when the connection drops. A `local()` collection keeps its rows in the browser, so reading and writing never wait for the network. The writes are sent to your actions later.

You declare the collection once, naming the actions you already have:

```kay
---
import { call, local } from 'kay'
import { remove, save } from '../routes/todos.kay'
import todosApi from '../api/todos'

const todos = local({ key: 'id', read: async signal => call(todosApi, '/', { signal }), put: save, remove })
---
p {todos.status()}
ul
  for todo of todos.rows()
    li {todo.title}
button(onClick={() => todos.put({ id: crypto.randomUUID(), title: 'New', rev: 0 })}) Add
```

`todos.put(row)` shows the row at once and keeps it in IndexedDB. `todos.remove(key)` does the same for a removal. The row type is the input of the `put` action, so nothing is typed twice.

## What happens to a write

Each write is queued and sent in order through the action you named. The action's guards, its schema and its rate limits all apply, as for any call. kay adds an id to every write, and the server runs an action only once per id, so a write whose answer was lost is never applied twice.

The queue is sent when the page loads, when the connection returns and when the tab becomes visible. If your site has `offline` or `push()` on, Chromium also sends it when every tab is closed.

A write the server answers with a 5xx five times is rejected, so one that always fails does not hold the queue. The count is kept on the write, so the page and the worker add to the same one. A read or a request that takes over 30 seconds counts as offline, and the `signal` given to `read` aborts then.

If the server refuses a write, for example because the schema rejects it or a guard says no, the row goes back to what the server last gave. `todos.issues()` lists the refusal, with the errors per field.

## When two writes meet

Say an action answers `ctx.fail(409, row)` with the row it holds when a write started from an older one. By default kay keeps the server's row and puts on it the fields your write changed. To decide yourself, give `conflict` a function. It gets the row you started from, your row and the server's row, and returns the row to keep.

## Signing out

The rows belong to the person who is signed in. kayjs-auth does this on sign-out. For a sign-out of your own, add the cookie `forgetLocalMirrors(request)` gives to the response. The next page that uses a collection empties the rows and the unsent writes, even offline.

# Special pages, load timing and error reporting

The rest of [Pages and routing](routing.md).

## Common tasks

- Show an error page, a 404 or a status page: [Show an error page](routing.md#show-an-error-page).

## Reference

### Loads and timing

- Layout and page loads run in parallel; when several fail, the outermost one decides the response.
- A layout cannot read its page's data, so a value they both need is returned by a guard (`ctx.guard`) or shared with `ctx.once(key, load)`, which runs the load once for the request ([Guards](guards.md)).
- In development each page response carries a `Server-Timing` header with the time of the guards, the import of the page's modules, the loads as a whole and each of them, and the render, shown in the browser's network panel; an action, an endpoint and an API route carry the time of their guards and handler.
- `observe: { serverTiming: true }` in kay.config.ts sends it in production too (see [Tracing and timing](tracing.md#tracing-and-timing)).

### Special pages

- The nearest special page wins, wrapped by the layouts of its own directory.
- `_error.kay` and the status pages read `ctx.error`: `status`, `message`, the `data` of the `ctx.deny` that ended the page (`ctx.deny(403, 'Upgrade', { plan: 'pro' })`, typed `unknown` unless the app sets `errorData` in `Register`: `declare module 'kay' { interface Register { errorData: { plan: string } } }`) and, in development only, `stack`.
- Logged and displayed stacks point at `.kay` lines.
- In production the message is generic and the real error goes to `console.error`.
- Without an `_error.kay` the response is plain text, and development shows an error page with the stack instead, its frames opening in the editor under `kay dev`.

```kay
--- server
const { status, message } = ctx.error
---
h1 Error {status}
p {message}
```

```kay
--- server
import { findTodo } from '../../data'

const id = Number(ctx.params.id)
const todo = await findTodo(id) ?? ctx.notFound()
---
h1 {todo.title}
p.status {todo.done ? 'Done' : 'Open'}
```

### Error reporting

- Each error kay logs while answering a request, from a load, a render, a guard, an action, an API route, an `onRequest` hook, a param matcher, `rewrite`, a streamed block without `catch` or a `try` block's, also goes to the `observe.onError` option of `kay.config.ts` or `pages()`, the place to send it to an error tracker. An error a hook of kay or a library threw comes with a `source` naming it, such as `'cms.onSave'`.
- The response does not wait for a promise it returns, and an error it throws is logged.
- An error met outside any request, in a `schedule`, `background` or queue job that ran out of attempts, or an `onStop` hook, goes to `onError` too, with `undefined` for the request, and kay waits 10 seconds at most for it, so a tracker that hangs holds neither a queue worker nor a shutdown.
- An island's error reaches it as a `BrowserError` (see [Error fallbacks](islands-state-to-ids.md#error-fallbacks)).
- `request.url` keeps its query, which may hold an address or a token, so a tracker is sent its path:

```ts
import { defineConfig, requestId } from 'kay/server'

export default defineConfig({
  observe: { onError: ({ error, request }) => tracker.capture(error, request && { path: new URL(request.url).pathname, id: requestId(request) }) },
})
```

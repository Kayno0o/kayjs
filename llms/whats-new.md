# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## 1.88.0

- A guard can return an object that the guards, layouts, pages and actions below it read as `ctx.guard`, typed by `kay check` from the `_guard.ts` files above the route, and `ctx.once(key, load)` shares one load between the loads of a request: [guards](server.md#guards).
- `kay.config.ts` takes `beforeRequest`, `onResponse`, `onStart`, `onStop` and `actions: { protect, maxSize, messages, beforeRun, onSuccess, onError }`, defaults and hooks for every request and every action; an action's options take `beforeRun`, `onSuccess` and `onError` too: [hooks](hooks.md#the-apps-own-hooks).
- kayjs-mail, kayjs-ai and kayjs-cms keep their data in the database of the app's `store`, old local files still read; `pgConversations` and `/pg`, `/sqlite` entries are new: [upgrading](upgrading.md).
- A call of an action takes `queue` (`'parallel'`, `'serial'`, `'latest'`, also `add.track({ queue })`), `timeout`, `retry`, the hooks `onStart`, `onSuccess`, `onError` and `onSettled`, and `refresh` a `resource()` or a list of them; optimistic changes of calls in flight roll back to where they began whichever fails first, a call that retries sends one `Idempotency-Key` header on every try, `optimistic(change)` gives `{ undo, keep }`, and a form posting in place fires `kay:action-start`, `kay:action-success` and `kay:action-error` (with `status` and `errors`): [calling actions from islands](actions-from-islands.md).
- `ctx.fail(status, data, errors)` puts a message on a named field of the action's schema (or on the form under `''`), so `error <field>`, `aria-invalid`, `add.error('field')`, the value re-fill, `ActionError.errors` and kayjs-ui `FormField` follow it with and without JavaScript: [actions](actions.md#refused-posts).
- `for` takes any iterable: [templates](templates.md#render-a-list).
- A client-only island shows an `@fallback` until it renders: [browser-only](browser-only.md#fallback-while-the-browser-renders).
- `ctx.cookies.delete` takes the `secure`, `sameSite` and `partitioned` a cookie was set with: [server](server.md#sessions).
- A `method="get"` form swaps in place: [navigation](navigation-from-code.md#full-loads-and-prefetching).
- `security: { cookies: {} }` hardens `ctx.cookies.set`: [sessions](server.md#sessions).
- `serve: { timeout: '15s' }` holds a page, action, API route and endpoint to a time: past it the request answers 504 (a page through `_error.kay`), is reported to `onError`, and `ctx.signal`, new on every request context, aborts; a page, `api({ timeout })` and an action set their own: [production](production.md#request-timeouts). `signal` is a new required member of `RequestContext`, `ActionContext`, `PageContext` and `ErrorPageContext`, so a context built by hand in a test needs one.

- A deferred server island that fails or times out is retried with a backoff and, if lost, keeps its inert copy with `data-kay-failed` and a `kay:server-island-error` event carrying the `ApiError` and `retry()`; `kay:server-island` follows a success, and leaving the page aborts the request: [server islands](server-islands.md#server-islands).

- A request's `traceparent` puts its server span under the caller's trace (`observe.extract` reads other formats, `false` ignores it), the response sends `traceresponse` and JSON log lines carry `trace`: [tracing](tracing.md#join-the-callers-trace).

Releases before 1.88 are in [What's new, older releases](whats-new-archive.md).

# Hooks

The rule the hooks of kay and its libraries (kayjs-auth, kayjs-ai, kayjs-cms, kayjs-mail, kayjs-ui) follow, and the helpers a library builds them with (`kay/library`).

## Common tasks

### Change or refuse a transition

A `beforeX` hook returns one of:

- nothing: X goes on unchanged;
- an object of the fields it may change, laid over the input;
- `false`: X is refused with the transition's default refusal.

It may also throw `refuse(message?, { status, errors, data })` from `kay`: 403 by default, 422 when `errors` names fields. The refusal has one shape, `ErrorShape`: `{ status, message, errors, data }`. A thrown `refuse()` carries it under `Symbol.for('kay.refused')`, so an action answers it as it answers `ctx.fail` (`message` is the form-wide error, `errors` the field errors, `data` what the call reads), as does every place answering that symbol, and `decide()` returns it as `refused`. Anywhere else a thrown `refuse()` is an ordinary error, a 500. Any other throw in a `beforeX` hook refuses as a server error (500), after it is logged and passed to `onError`: it fails closed.

```ts
import { action, refuse } from 'kay'

export const publish = action(schema, ({ summary }) => {
  if (summary === '')
    refuse('A summary is needed', { errors: { summary: 'required' } })
  // ...
})
```

### Build hooks in a library

A library's factory takes the hook keys in its options and runs them with the helpers:

```ts
import type { BeforeHook, Hook } from 'kay/library'
import { decide, dispatch, refuse } from 'kay/library'

interface NotesOptions {
  beforeSave?: BeforeHook<{ text: string }, { text: string }> | undefined
  onSave?: Hook<{ text: string }> | undefined
}

export function notes({ beforeSave, onSave }: NotesOptions) {
  return async (input: { text: string }) => {
    const answer = await decide('notes.beforeSave', [beforeSave], input)

    if ('refused' in answer)
      refuse(answer.refused.message, answer.refused)

    const saved = { ...input, ...answer.change }

    await dispatch('notes.onSave', [onSave], saved)

    return saved
  }
}
```

- `dispatch(source, hooks, event, { detached })` never rejects. `source` is `'<library>.<hook>'`, what `onError` receives. `undefined` entries are skipped, so options pass straight through. `detached: true` does not wait for the hooks.
- `decide(source, hooks, event)` answers `{ change }` or `{ refused }`, the refusal as `ErrorShape`. A `false` is `{ status: 403, message: 'Refused' }`, a throw other than a refusal (`refuse()` or any error carrying `Symbol.for('kay.refused')`) is reported and answers 500.
- Throw the refusal on with `refuse()`, or as the transition's own error where the library has one: `refused.status`, `.message`, `.errors`, `.data` and `.retryAfter` carry what to answer.

## Reference

### What ships

This release ships the helpers (`dispatch()`, `decide()`, `hookContext()`, `HookContext`, `Hook`, `BeforeHook`), `refuse()` and `ErrorShape` (from `kay` too), and `source` on `observe.onError` of `kay.config.ts`. `dispatch()` was `notify()` before 1.92, which now names only the inbox of `kay/server`. kayjs-auth's, kayjs-ai's, kayjs-mail's and kayjs-cms's hooks follow it (`onEvent`, `beforeDelete`, `onSignUp`, [below](#kayjs-auth); `beforeRequest`, `onSuccess`, `onError`, [kayjs-ai](#kayjs-ai); `beforeSend`, `onSend`, [kayjs-mail](#kayjs-mail); `beforeSave`, `onSave`, `beforeUpload`, `onUpload`, [kayjs-cms](#kayjs-cms)); kayjs-ui's callbacks follow it ([below](#kayjs-ui)); the other hooks that exist today keep their names; queues, workflows and schedules already follow the rule (`onStart`, `onSuccess`, `onRetry`, `onError`). Later releases rename them to the rule and list each rename in [Upgrading](upgrading.md) with a `kay upgrade` fix. New hooks follow the rule from the start.

### The rule

- `onX` runs after X happened and only observes: what it returns is ignored. X is the verb of the transition in its base form, as the DOM names events: `onSave`, `onSend`, `onDelete`, `onSubscribe`. Never a participle (`onSaved`, `onSent`, `onFailed`).
- `beforeX` runs before X and is the only hook that changes or refuses it.
- Anything with a start and an outcome (a job, a schedule run, a workflow run, an ask, an action) uses `onStart`, `onSuccess` and `onError`, plus steps of its own (`onStep`, `onToolCall`, `onRetry`). It is `onError`, never `onFail` or `onFailed`.
- One object argument: the transition's fields plus `context`. A hook gets `{ user, context }`, not `(user, context)`.
- Hooks are flat keys in the options of the factory that owns the transition (`auth({ onEvent })`), never a `hooks: {}` bag. App-wide hooks go in `kay.config.ts`.
- A library with many audit-style transitions may add one catch-all `onEvent({ event, ...fields, context })`, `event` in kebab case, beside the per-transition hooks.
- Not hooks: resolvers (`allow`, `authorize`, `locate`, `exportData`, `profileFields`) compute a value the library needs, are awaited and let their errors propagate; a controlled-state pair keeps `on<Prop>Change` (`open` and `onOpenChange`).
- A function that registers a hook is `on` plus the hook's name: `onBeforeNavigate(fn)` registers `beforeNavigate`. Browser hooks follow the same rule, and are never a security boundary: the server checks again.

### Errors in `onX`

An `onX` hook run by `dispatch()` is awaited for up to 10 s, then left running. A throw, or a hook that finishes late, is logged and handed to the app's `onError({ error, request, source })` with `source` naming the hook (`'cms.onSave'`); it never undoes or fails the transition. In the browser a hook that throws is logged and the transition goes on.

`detached` hooks (streaming paths, timing-sensitive paths) run off the response's path: not awaited, the same logging.

### Order

For one transition: the library's own work (log, counters), the app-wide hooks of `kay.config.ts`, the hooks in the extension's options (or its `src/<lib>.ts`), the per-call hook. A per-call hook adds to the options' hooks, it never replaces them. `beforeX` hooks run after the access checks and before validation, so what they change is validated; each sees the value the previous one left and the first refusal stops the chain. `onX` hooks all run in that order and a throw does not skip the next.

### The app's own hooks

`kay.config.ts` takes flat keys, all optional: `beforeRequest`, `onResponse`, `onStart`, `onStop`, and `actions: { protect, maxSize, messages, beforeRun, onSuccess, onError }`.

```ts
export default defineConfig({
  beforeRequest: ({ request, url, context }) => (blocked(context.ip) ? false : undefined),
  onResponse: ({ request, url, status, duration }) => metrics.count(url.pathname, status, duration),
  onStart: ({ url }) => console.log(`listening on ${url}`),
  onStop: async () => pool.end(),
  actions: {
    protect: { rateLimit: { max: 30, window: '1m' } },
    onError: ({ action, file, status, message }) => audit(action, file, status, message),
  },
})
```

- `beforeRequest({ request, url, locals, context })` runs before the guards, the loads and the validation of the input of every request that reaches a route (a page, an action, an endpoint, an API route, an extension's route), after kay's own host, proxy and security checks, so a refused caller learns nothing from a field error. `false` or a thrown `refuse()` refuses it, 403 or the refusal's status; a returned `Response` answers instead; any other throw, or a hook that does not finish in 10 s, answers 500 and is reported with source `beforeRequest`. `locals` holds what kay and the app's own plugins added before it, not the `derive` and `resolve` values of extensions: read who asks from `context`.
- `onResponse({ request, url, locals, status, duration })` is told after the answer is made, `duration` in milliseconds, up to the first byte for a streamed answer. A throw is reported with source `onResponse`.
- `onStart({ url })` runs when the server listens and `onStop()` when it stops, after the open requests finished and after the `onStop` hooks of the plugins and extensions; a throw is reported and the others still run.
- `actions.beforeRun({ action, file, input, ctx })` runs before every action's handler, once the guards and the schema let the post through; `false` or `refuse()` fails the post. It cannot change the input. `onSuccess` adds `result`, `onError` adds `status`, `message`, `errors`, `data` and `error` (undefined for `ctx.fail`).
- A redirect the handler throws is a success (the action did its work, as in post-redirect-get): `onSuccess` is told it with `result` undefined, and `onError` is not. `onSuccess` of a streaming action is told as the stream starts, before it is read.
- The app's action hooks run before the action's own (`action(schema, handler, { onSuccess })`), both observing, a throw reported and never failing the action.

### The context

Every hook gets `context: HookContext`, from `kay/library` (the type also from `kay/server`):

```ts
interface HookContext {
  request: Request | undefined // undefined in a job, a schedule, a prune
  ip: string | undefined
  userAgent: string | undefined
  userId: string | undefined // the id a library named with nameUser, as userOf reads it
  locale: string | undefined
}
```

A library extends it with what it knows. `hookContext()` builds it from the request being answered.

### Session and file hooks

- `session({ onCreate, onDestroy })` (source `session.onCreate`, `session.onDestroy`) are told `({ id, context })`, `id` being the stored session's id (undefined for a session kept in the cookie). `onCreate` runs after the response that sets a visitor's first data; `onDestroy` after `destroy()`, a session left with no data or one past its absolute lifetime. A forged or expired cookie being cleared tells nothing, and `regenerate()` neither: it is the same session going on. Both feed `kay_session_events_total{event}` (`created`, `destroyed`).
- A `FileStore` takes `onWrite({ key, size, private, context })` and `onDelete({ key, context })` (source `files.onWrite`, `files.onDelete`), as options of `diskFiles(dir, hooks)`, `memoryFiles(hooks)` and `s3Files({ ... })`, or as keys of a store of the app's own: [files](files.md#stores). They feed `kay_file_events_total{event}` (`written`, `deleted`).

### kayjs-auth

- `auth({ onEvent, beforeDelete, onSignUp })`, flat keys or the `hooks` of `src/auth.ts`, each told its fields and `context: AuthHookContext`, kay's `HookContext` plus `actor: User | null` (the admin or manager who acted, else `null`).
- `onEvent({ event, user, context, ...fields })` is the catch-all of the account's audit events (source `auth.onEvent`).
- `beforeDelete({ user, context })` runs before an account is erased, by the user, an admin or the prune; `false` or `refuse()` keeps it, and `account.delete` and `admin.deleteUser` answer `{ ok: false, error: { code: 'refused', status, message } }` (source `auth.beforeDelete` for a throw, which refuses with 500).
- `onSignUp({ user, profile, context })` is observed: a throw is reported with source `auth.onSignUp` and the sign-up stands. It used to fail the call after the user was written.

### kayjs-ai

- `ai({ beforeRequest, onStep, onToolCall, onSuccess, onError })` and the same keys in `ask(prompt, { ... })`, each told its fields and `context: HookContext` ([details](../packages/ai/llms/hooks.md)). `beforeRequest` may change the request, refuse with `false` or throw (an `AiError` or `refuse()`), and fails closed; the others only observe, are not waited for, and a throw is reported with source `ai.onStep`, `ai.onToolCall`, `ai.onSuccess` or `ai.onError`.
- `onError({ error, context })` is told an object, where it was told the error before 1.92 (a `kay upgrade` fix wraps the parameter).
- A hook given to `ask()` adds to the one of `ai()` of the same name, `ai()`'s first, instead of replacing it.

### kayjs-mail

- `mailer({ beforeSend, onSend, onError, onSuppress })` and, on `mail.list(name, { ... })`, `onSubscribe`, `onConfirm`, `onUnsubscribe` and `onBroadcast`; `contactForm(mail, { onSend, to })` ([details](../packages/mail/llms/writing-and-sending.md#hooks)). Sources are `mail.<hook>`, `mail.list.<hook>` and `mail.contact.onSend`.
- `beforeSend({ mail })` runs once per mail before it is sent, queued or mailed to a list subscriber; it may change the mail, or refuse it with `false` or `refuse()`, which `send()` and `enqueue()` throw. The others observe: `onSend({ mail, delivery })` once after the transport took the mail (the queue and lists too), `onError({ mail, error })` once when a send fails or the queue gives a mail up, `onSuppress({ address, reason, source })` for a bounce, a complaint or `mail.suppress()`.

### kayjs-cms

- `cms({ beforeSave, onSave, beforeUpload, onUpload })` ([details](../packages/cms/llms/loaders.md#before-a-save), [uploads](../packages/cms/llms/uploads.md#hooks)), each told its fields and `context: HookContext`.
- `beforeSave({ collection, slug, locale, verb, data, body, previous, author, from })` runs before every write of an entry but a reorder (`add`, `update`, `publish`, `unpublish`, `duplicate`, `restore`, `delete`, `rename`), after `roles`, `can` and `fourEyes` and before the schema and the version check. It may return `{ data, body }`, refuse with `false` or `refuse()` (shown in the entry form, `error.status` 422 or 403 to the API), and fails closed (500) on any other throw, source `cms.beforeSave`.
- `beforeUpload({ collection, name, type, size, bytes, author })` may return `{ bytes, name, type }` or refuse, the route answering the refusal's status; the result is checked against `uploads` again. `onUpload({ collection, key, path, name, type, size, author })` and `onSave` (which also gets `data`, `body` and `previous`) observe, a throw being reported with source `cms.onUpload` or `cms.onSave`.

### kayjs-ui

- `onSave(result)` of Form, FormDialog and SaveForm (was `onSaved`), `onSend(data)` of ContactForm and SubscribeForm (was `onSent`), `onEnd()` of AudioPlayer (was `onEnded`) and `onError({ error })` of CopyButton (was `onFail`, since 1.90) are base-form `onX` props, told what they were told before. A component prop takes the transition's value directly, as the DOM and `onOpenChange` do; the object with a `context` belongs to server hooks.
- SaveForm's `onSave` hears the `action`'s result; the call that does the save for an editor with no `action` is `save`.
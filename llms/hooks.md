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
import { decide, notify, refuse } from 'kay/library'

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

    await notify('notes.onSave', [onSave], saved)

    return saved
  }
}
```

- `notify(source, hooks, event, { detached })` never rejects. `source` is `'<library>.<hook>'`, what `onError` receives. `undefined` entries are skipped, so options pass straight through. `detached: true` does not wait for the hooks.
- `decide(source, hooks, event)` answers `{ change }` or `{ refused }`, the refusal as `ErrorShape`. A `false` is `{ status: 403, message: 'Refused' }`, a throw other than a refusal (`refuse()` or any error carrying `Symbol.for('kay.refused')`) is reported and answers 500.
- Throw the refusal on with `refuse()`, or as the transition's own error where the library has one: `refused.status`, `.message`, `.errors`, `.data` and `.retryAfter` carry what to answer.

## Reference

### What ships

This release ships the helpers (`notify()`, `decide()`, `hookContext()`, `HookContext`, `Hook`, `BeforeHook`), `refuse()` and `ErrorShape` (from `kay` too), and `source` on `observe.onError` of `kay.config.ts`. The hooks that exist today keep their names (`onAuthEvent`, kayjs-ai's `onRequest` and `onFinish`, kayjs-ui's `onSaved`); queues, workflows and schedules already follow the rule (`onStart`, `onSuccess`, `onRetry`, `onError`, with the queue's `onFailed` deprecated for `onError`). Later releases rename them to the rule and list each rename in [Upgrading](upgrading.md) with a `kay upgrade` fix. New hooks follow the rule from the start.\n
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

An `onX` hook run by `notify()` is awaited for up to 10 s, then left running. A throw, or a hook that finishes late, is logged and handed to the app's `onError({ error, request, source })` with `source` naming the hook (`'cms.onSave'`); it never undoes or fails the transition. In the browser a hook that throws is logged and the transition goes on.

`detached` hooks (streaming paths, timing-sensitive paths) run off the response's path: not awaited, the same logging.

### Order

For one transition: the library's own work (log, counters), the app-wide hooks of `kay.config.ts`, the hooks in the extension's options (or its `src/<lib>.ts`), the per-call hook. A per-call hook adds to the options' hooks, it never replaces them. `beforeX` hooks run after the access checks and before validation, so what they change is validated; each sees the value the previous one left and the first refusal stops the chain. `onX` hooks all run in that order and a throw does not skip the next.

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

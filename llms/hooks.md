# Hooks

One convention names and shapes the callbacks of kay and its libraries (kayjs-auth, kayjs-ai, kayjs-cms, kayjs-mail, kayjs-ui). A new library hook follows it; this file is the rule and the helpers a library builds hooks with (`kay/library`).

## The rule

- `onX` runs after X happened and only observes: what it returns is ignored. X is the verb of the transition in its base form, as the DOM names events: `onSave`, `onSend`, `onDelete`, `onSubscribe`. Never a participle (`onSaved`, `onSent`, `onFailed`).
- `beforeX` runs before X and is the only hook that changes or refuses it.
- Anything with a start and an outcome (a job, a schedule run, a workflow run, an ask, an action) uses `onStart`, `onSuccess` and `onError`, plus steps of its own (`onStep`, `onToolCall`, `onRetry`). It is `onError`, never `onFail` or `onFailed`.
- One object argument: the transition's fields plus `context`. A hook gets `{ user, context }`, not `(user, context)`.
- Hooks are flat keys in the options of the factory that owns the transition (`auth({ onEvent })`, `cms({ beforeSave })`), never a `hooks: {}` bag. App-wide hooks go in `kay.config.ts`.
- A library with many audit-style transitions may add one catch-all `onEvent({ event, ...fields, context })`, `event` in kebab case, beside the per-transition hooks.
- Not hooks: resolvers (`allow`, `authorize`, `locate`, `exportData`, `profileFields`) compute a value the library needs, are awaited and let their errors propagate; a controlled-state pair keeps `on<Prop>Change` (`open` and `onOpenChange`).
- A function that registers a hook is `on` plus the hook's name: `onBeforeNavigate(fn)` registers `beforeNavigate`. Browser hooks follow the same rule, and are never a security boundary: the server checks again.

## Change or refuse

A `beforeX` hook returns one of:

- nothing: X goes on unchanged;
- an object of the fields it may change, laid over the input;
- `false`: X is refused with the transition's default refusal (cms 403, mail dropped, navigation cancelled).

It may also throw `refuse(message?, { status, errors, data })` from `kay`, which refuses with that message and status: 403 by default, 422 when `errors` names fields. The refusal has one shape everywhere, `{ status, message, errors, data }`, and an action answers it as it answers `ctx.fail`: `message` is the form-wide error, `errors` the field errors, `data` what the call reads. Any other throw refuses as a server error (500): it fails closed, after the error is logged and passed to `onError`.

```ts
import { refuse } from 'kay'

cms({ beforeSave: ({ data, context }) => data.summary ? { data: { ...data, updatedBy: context.userId } } : refuse('A summary is needed', { errors: { summary: 'required' } }) })
```

## Errors in `onX`

An `onX` hook is awaited for up to 10 s, then left running. A throw, or a hook that finishes late, is logged and handed to the app's `onError({ error, request, source })` with `source` naming the hook (`'cms.onSave'`); it never undoes or fails the transition. In the browser a hook that throws is logged and the transition goes on.

`detached` hooks (ai's streaming, auth's timing-sensitive paths) run off the response's path: not awaited, the same logging.

## Order

For one transition: the library's own work (log, counters), the app-wide hooks of `kay.config.ts`, the hooks in the extension's options (or its `src/<lib>.ts`), the per-call hook. A per-call hook adds to the options' hooks, it never replaces them. `beforeX` hooks run after the access checks and before validation, so what they change is validated; each sees the value the previous one left and the first refusal stops the chain. `onX` hooks all run in that order and a throw does not skip the next.

## The context

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

A library extends it with what it knows (`AuthHookContext extends HookContext { actor: User | null }`). `hookContext()` builds it from the request being answered.

## Building hooks in a library

```ts
import type { BeforeHook, Hook } from 'kay/library'
import { decide, notify } from 'kay/library'

// observe: awaited in order, a throw logged and reported, never thrown
await notify('cms.onSave', [options.onSave, perCall.onSave], { entry, previous })

// change or refuse: each hook sees the last one's change, the first refusal stops
const answer = await decide<Input, Fields>('cms.beforeSave', [options.beforeSave], input)

if ('refused' in answer)
  throw new SaveRefused(answer.refused)

const saved = { ...input, ...answer.change }
```

- `notify(source, hooks, event, { detached, timeout })` never rejects. `source` is `'<library>.<hook>'`, what `onError` receives. `undefined` entries are skipped, so options pass straight through. `detached: true` does not wait for the hooks. `timeout` defaults to 10 000 ms.
- `decide(source, hooks, event)` answers `{ change }` or `{ refused }`, the refusal in the shape above. A `false` is `{ status: 403, message: 'Refused' }`, a throw other than `refuse()` is reported and answers 500.
- Throw the refusal as the transition's own error where the library has one (cms 403, mail dropped): `refused.status`, `.message`, `.errors` and `.data` carry what to answer.

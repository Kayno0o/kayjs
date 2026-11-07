---
title: Hooks
order: 8.6
description: The rule kay and its libraries follow to name their hooks, what a hook may change, and what happens when one throws.
---

Kay and its libraries let you react to what they do with callbacks called hooks. This page is the rule they follow, so a hook you have written for one feature reads the same for the next.

## What this release ships

This release ships the helpers libraries build hooks with, `refuse()`, and the `source` that `onError` receives. kayjs-auth's hooks follow the rule (`onEvent`, `beforeDelete` and `onSignUp`, which get a `context` with the `actor`); the others keep their names for now, such as `onRequest` in kayjs-ai. Queues, workflows and schedules already follow the rule. Later releases rename them to this rule, each with a `kay upgrade` fix. New hooks follow it from the start.

## Names

- `onX` runs after X happened. It only watches: whatever it returns is ignored. X is the verb in its base form, as in the browser: `onSave`, `onSend`, `onDelete`. Never `onSaved` or `onSent`.
- `beforeX` runs before X. It is the only kind of hook that can change X or stop it.
- Something that starts and then succeeds or fails, such as a job, a schedule run, a workflow run or a question to an AI model, has `onStart`, `onSuccess` and `onError`. Some add steps of their own, such as `onRetry` or `onToolCall`. The failure hook is always `onError`, never `onFail` or `onFailed`.
- A library that has many audit-style events may also offer one `onEvent` that gets them all, with the event's name in kebab case.

Options that work out a value the library needs, such as `allow`, `authorize` or `locate`, are not hooks. They are awaited, and an error they throw is not swallowed. A pair like `open` and `onOpenChange` is the state of a component, not a hook.

## What a hook gets

A hook gets one object: the fields of what happened, and a `context`. The `context` tells where the hook runs: the `request` (missing in a job or a schedule), the `ip`, the `userAgent`, the `userId` and the `locale`. Libraries add what they know, such as the signed-in user.

Hooks are plain keys in the options of the feature that owns them. Hooks that apply to the whole app go in `kay.config.ts`. A hook given for one call runs after the ones in the options and never replaces them.

## Changing or refusing

A `beforeX` hook can return nothing, and X goes on. It can return an object with the fields to change, and they are laid over the input before it is checked. It can return `false` to stop X in the way that feature stops things.

To stop X with a message, throw `refuse()`. It works in an action as well:

```ts
import { action, refuse } from 'kay'

export const publish = action(schema, ({ summary }) => {
  if (summary === '')
    refuse('A summary is needed', { errors: { summary: 'required' } })
  // ...
})
```

The status is 403 unless you pass `errors`, which makes it 422, or a `status`. The visitor gets it as they get `ctx.fail`: the message at the top of the form, the errors beside their fields, and `data` for your code.

A thrown `refuse()` is answered this way in actions, in the `beforeX` hooks of libraries that use `decide()`, and wherever else kay answers `Symbol.for('kay.refused')`, as kayjs-ai does for its limits. Thrown anywhere else, it is an ordinary error and answers 500.

When several `beforeX` hooks are set, each sees what the one before changed, and the first to refuse ends the chain. If a `beforeX` hook throws anything else, X is refused with a 500 error and the error is reported. A broken check never lets something through.

## Hooks for the whole app

`kay.config.ts` takes the same flat keys. `beforeRequest` runs before the guards of every request that reaches a route and can refuse it with `false` or `refuse()`, or answer with a `Response`. `onResponse` is told the status and the duration of every answer. `onStart` and `onStop` run when the server listens and when it stops; `onStop` runs after the hooks of plugins and extensions. A redirect an action throws counts as a success for `onSuccess`.

```ts
export default defineConfig({
  beforeRequest: ({ context }) => (isBlocked(context.ip) ? false : undefined),
  onResponse: ({ url, status, duration }) => metrics.count(url.pathname, status, duration),
  onStop: async () => pool.end(),
})
```

Every action gets the same treatment from `actions`: `beforeRun`, `onSuccess` and `onError` run for each action before the ones the action sets itself. `beforeRun` can refuse a run but not change its input.

## When an `onX` hook throws

The transition has already happened, so the error never undoes it. The error is logged and handed to the `observe.onError` of `kay.config.ts` with a `source` naming the hook, such as `cms.onSave`. Kay waits up to 10 seconds for a hook, then leaves it running, reports that it was late, and goes on. All the `onX` hooks of one transition run in order, even when one throws.

Hooks that must not slow an answer, such as the ones of a streamed reply, run detached: kay does not wait for them at all.

## Browser hooks

The same names work in the browser. A hook that throws there is logged and the page goes on. A browser hook is never a security check, because anyone can skip it. The server checks again.

## Writing a library

A library builds its hooks with `dispatch()` and `decide()` from `kay/library`, which give every hook the same order, timeout and error handling. `dispatch(source, hooks, event)` runs the `onX` hooks, and `decide(source, hooks, event)` runs the `beforeX` hooks and answers the change or the refusal.

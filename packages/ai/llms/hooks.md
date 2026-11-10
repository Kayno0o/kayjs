# Hooks around an ask

## Common tasks

### Log, redact, moderate or bill every ask

Set the hooks once in `ai({ ... })` in `kay.config.ts`, and every `ask()` runs them, whether it is awaited, streamed to a `Chat` by an action, structured (`schema`) or grounded (`ground()` only builds the `system` and `sources` an ask is given). Nothing wraps `ask`, so `.progress()`, `reply.steps` and the `Chat` wiring stay as they are. They follow [kay's hook convention](../../../llms/hooks.md): `beforeX` may change or refuse, `onX` only observes, one object argument with a `context`.

```ts
ai({
  // Before the provider is called: change the request, return false or throw to refuse it.
  beforeRequest: ({ messages, system }) => {
    if (flagged(messages.at(-1)?.content))
      throw new AiError('invalid', 'That question cannot be asked')

    return { messages: messages.map(m => ({ ...m, content: redact(m.content) })) }
  },
  onSuccess: ({ usage, steps, stopped, context }) => bill(context.userId, usage, steps.length, stopped),
  onToolCall: call => trace(call.name, call.status, call.ms),
  onError: ({ error }) => report(error),
})
```

The same names in `ask(prompt, { onSuccess })` add to the ones of `ai()` for that ask: the hooks of `ai()` run first, then the ask's, and for `beforeRequest` each sees the request the one before left.

## Reference

### What each hook gets

Every hook is told its fields and `context`, kay's `HookContext` (`request`, `ip`, `userAgent`, `userId`, `locale`) of the request being answered, its fields undefined outside one.

- `beforeRequest({ messages, system, model, options, context })`: the messages (with their attachments) and system prompt as the ask has them, the model chosen and the ask's options. It returns nothing, or `{ messages?, system? }` to send those instead (a field left out stays; `system: undefined` sends none), and may be async. `false` refuses the ask with `refuse()` (a 403 an action answers as it answers `ctx.fail`). A throw refuses it too: the reply fails with that error (an `AiError` is the usual one, and a visitor-facing kind such as `limited` or `too-long` answers an action as it does elsewhere), `onError` is told, and the provider is never called. It runs after the input-length check of the original messages and before the limits count the ask, so a refused ask counts nothing and the budget and the dev tool see the request it left, once; a request it grew past `maxInputChars` fails with `too-long`.
- `onStep(step)`: the `Step` of each request made to the provider (`ms`, `firstTokenMs`, `usage`, `finish`, `calls`, `provider`, `model`, `attempt`, `failed`), a tool loop making one per round, and one for each request that failed and was [retried or fell back](asking.md#when-a-provider-fails). Failed attempts now reach it, and a failing request can cost up to two requests per model.
- `onToolCall(call)`: the `AiToolCall` as each tool starts (`running`) and again as it ends (`done` or `failed`, with `ms`), in the order they ran.
- `onSuccess({ text, usage, steps, finish, stopped, context })`: once the reply ended, with its whole text, the tokens (undefined when the provider gave none), every step and why the model stopped. `stopped` is true for a reply stopped by `reply.stop()`, an aborted request or a reader that left, which has what arrived by then. A `schema` is checked after it, so an answer it refuses still ends here.
- `onError({ error, context })`: the error the reply's readers get, from the provider, a limit, or `beforeRequest`, and each failed request that was retried or fell back before it. Failed attempts now reach it, and a failing request can cost up to two requests per model. A stopped reply is not an error.

A hook that only notifies (all but `beforeRequest`) is called as the event happens, one that is async is not waited for, and a throw or a rejected promise is logged, handed to the app's `onError` with source `ai.onStep`, `ai.onToolCall`, `ai.onSuccess` or `ai.onError`, and never fails the reply. A hook is called once per ask however many readers the reply has.

### The names before 1.92

`onError` is told `{ error, context }`, where it was told the error itself before 1.92.

### The fake

Under `bun test`, and in development until a provider is configured, the fake answers. The hooks of `ai()` do not run for an ask the fake answers, so a bill or an audit trail is not written by a test. A hook given to the ask itself runs whichever provider answers, which is how a test checks one.

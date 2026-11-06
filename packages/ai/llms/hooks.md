# Hooks around an ask

## Common tasks

### Log, redact, moderate or bill every ask

Set the hooks once in `ai({ ... })` in `kay.config.ts`, and every `ask()` runs them, whether it is awaited, streamed to a `Chat` by an action, structured (`schema`) or grounded (`ground()` only builds the `system` and `sources` an ask is given). Nothing wraps `ask`, so `.progress()`, `reply.steps` and the `Chat` wiring stay as they are.

```ts
ai({
  // Before the provider is called: change the request, or throw to refuse it.
  onRequest: ({ messages, system }) => {
    if (flagged(messages.at(-1)?.content))
      throw new AiError('invalid', 'That question cannot be asked')

    return { messages: messages.map(m => ({ ...m, content: redact(m.content) })) }
  },
  onFinish: ({ usage, steps, stopped }) => bill(tenant(), usage, steps.length, stopped),
  onToolCall: call => trace(call.name, call.status, call.ms),
  onError: error => report(error),
})
```

The same names in `ask(prompt, { onFinish })` replace the one of `ai()` for that ask, hook by hook.

## Reference

### What each hook gets

- `onRequest({ messages, system, model, options })`: the messages (with their attachments) and system prompt as the ask has them, the model chosen and the ask's options. It returns nothing, or `{ messages?, system? }` to send those instead (a field left out stays; `system: undefined` sends none), and may be async. A throw refuses the ask: the reply fails with that error (an `AiError` is the usual one, and a visitor-facing kind such as `limited` or `too-long` answers an action as it does elsewhere), `onError` is told, and the provider is never called. It runs after the input-length check of the original messages and before the limits count the ask, so a refused ask counts nothing and the budget and the dev tool see the request it left, once; a request it grew past `maxInputChars` fails with `too-long`.
- `onStep(step)`: the `Step` of each request made to the provider (`ms`, `firstTokenMs`, `usage`, `finish`, `calls`, `provider`, `model`, `attempt`, `failed`), a tool loop making one per round, and one for each request that failed and was [retried or fell back](asking.md#when-a-provider-fails).
- `onToolCall(call)`: the `AiToolCall` as each tool starts (`running`) and again as it ends (`done` or `failed`, with `ms`), in the order they ran.
- `onFinish({ text, usage, steps, finish, stopped })`: once the reply ended, with its whole text, the tokens (undefined when the provider gave none), every step and why the model stopped. `stopped` is true for a reply stopped by `reply.stop()`, an aborted request or a reader that left, which has what arrived by then. A `schema` is checked after it, so an answer it refuses still finishes here.
- `onError(error)`: the error the reply's readers get, from the provider, a limit, or `onRequest`, and each failed request that was retried or fell back before it. A stopped reply is not an error.

A hook that only notifies (all but `onRequest`) is called as the event happens, a throw or a rejected promise is logged and never fails the reply, and one that is async is not waited for. A hook is called once per ask however many readers the reply has.

### The fake

Under `bun test`, and in development until a provider is configured, the fake answers. The hooks of `ai()` do not run for an ask the fake answers, so a bill or an audit trail is not written by a test. A hook given to the ask itself runs whichever provider answers, which is how a test checks one.

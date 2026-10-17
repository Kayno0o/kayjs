# kayjs-ai: Environment, ask() and its reply

## Environment

- `ANTHROPIC_API_KEY`: Anthropic's Messages API.
- `OPENAI_API_KEY`: OpenAI's chat completions at `https://api.openai.com/v1`.
- `AI_BASE_URL`: an OpenAI-compatible server's API root, `http://localhost:11434/v1` for Ollama; its key, when it wants one, is `OPENAI_API_KEY`. With `AI_PROVIDER=anthropic` it is a proxy's root for Anthropic instead.
- `AI_MODEL`: the default model, `ask(..., { model })` overrides it. Required in production, which `kay env` shows as such once `ai()` is in `extensions`.
- `AI_PROVIDER` (`anthropic` or `openai`): only needed when both keys are set, as `ask` throws rather than pick an account to bill.

The provider is `AI_BASE_URL` when set, else the one key set. Nothing is read at import: a missing variable throws at the `ask()` call, naming what to set, and never while `kay build` runs.

## ask

```ts
import { ask } from '@kaynooo/kayjs-ai'

ask('Why is the sky blue?')
ask([{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Again' }], { system: 'Answer in French', maxTokens: 500 })
```

`ask(prompt | messages, options?)` returns a `Reply` at once. A prompt is one user message; messages are `{ role: 'user' | 'assistant', content: string }`, other fields dropped.

Options: `system`, `model`, `maxTokens` (4096 by default, as Anthropic requires one), `temperature`, `signal`, and `provider` to ask a provider built by hand.

## The reply

- `await reply` is the full text; it throws the `AiError` the provider failed with.
- `for await (const text of reply)` yields snapshots, each the text so far; `reply.deltas()` yields the pieces alone.
- `await reply.usage` is `{ inputTokens, outputTokens }`, or undefined when the provider gave none or the reply failed; it never rejects, and reading it starts the reply.
- `reply.stop()` aborts the provider request, what came staying the text of `await`.
- All readers share one request, which starts on the first read. The request being answered aborting, `options.signal` aborting or a reader leaving early stops it.

## In a page

An `await` block takes the reply as it is and renders `then` again with each snapshot (see kay's rendering docs):

```kay
--- server
import { ask } from '@kaynooo/kayjs-ai'

const summary = ask('Summarise kay in one line')
---
await summary
  p Thinking
then text
  p {text}
catch
  p The reply was cut short
```

## From an island

An action returning the reply streams it to the island calling it, with the action's guards, schema, rate limits and cross-site check in front; a plain form post or an MCP call gets the last snapshot.

```kay
--- server
import { s } from 'kay'
import { ask } from '@kaynooo/kayjs-ai'

export const reply = action(s.Object({ messages: s.Array(s.Object({ role: s.UnionEnum(['user', 'assistant']), content: s.String({ maxLength: 4000 }) }), { minItems: 1, maxItems: 40 }) }), ({ messages }) => ask(messages, { system: 'You answer for the shop' }))
---
p Chat
```

In the island, `const stream = await reply({ messages })` resolves with an `ActionStream` whose `last()` is the text so far. Bound the history in the schema (`maxItems`, `maxLength`) and rate limit the action: each call bills.

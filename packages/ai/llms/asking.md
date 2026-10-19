# kayjs-ai: Environment, ask() and its reply

## Environment

- `ANTHROPIC_API_KEY`: Anthropic's Messages API.
- `OPENAI_API_KEY`: OpenAI's chat completions at `https://api.openai.com/v1`.
- `AI_BASE_URL`: an OpenAI-compatible server's API root, `http://localhost:11434/v1` for Ollama; its key, when it wants one, is `OPENAI_API_KEY`. With `AI_PROVIDER=anthropic` it is a proxy's root for Anthropic instead.
- `AI_MODEL`: the default model, `ask(..., { model })` overrides it. Required in production, which `kay env` shows as such once `ai()` is in `extensions`.
- `AI_PROVIDER` (`anthropic` or `openai`): only needed when both keys are set, as `ask` throws rather than pick an account to bill.

Mistral: `AI_BASE_URL=https://api.mistral.ai/v1`, its key in `OPENAI_API_KEY`, `AI_MODEL=mistral-small-2603`. Pin a dated model id: an alias such as `mistral-small-latest` moves to the next model and bills at its price. Nothing else is set: kay drops the `stream_options` Mistral refuses, reads its array content for the text, and counts the usage it sends unasked.

The provider is `AI_BASE_URL` when set, else the one key set. Nothing is read at import: a missing variable throws at the `ask()` call, naming what to set, and never while `kay build` runs.

## ask

```ts
import { ask } from '@kaynooo/kayjs-ai'

ask('Why is the sky blue?')
ask([{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Again' }], { system: 'Answer in French', maxTokens: 500 })
```

`ask(prompt | messages, options?)` returns a `Reply` at once. A prompt is one user message; messages are `{ role: 'user' | 'assistant', content: string }`, other fields dropped.

Options: `system`, `model`, `maxTokens` (4096 by default, as Anthropic requires one), `temperature`, `cache`, `signal`, `timeout`, `tools`, `maxSteps` and `confirm` ([Actions as tools](tools.md)), `maxInputChars` (50,000, [limits](limits.md#the-size-of-the-input)), and `provider` to ask a provider built by hand.

## Prompt caching

On by default, so a chat does not pay full price for its system prompt, tools and history on every turn and tool step. Anthropic gets the top-level `cache_control: { type: 'ephemeral' }` (automatic caching: the breakpoint moves to the last cacheable block); a prompt under the model's minimum is simply not cached. An OpenAI-compatible server gets a `prompt_cache_key`, a hash of the system prompt and the first message, so every turn and tool step of a conversation shares one key and no two conversations do. It caches long prompts on its own either way. A server refusing the key (400 or 422, Ollama or a strict gateway) is asked again without it, once per process and base URL, with nothing set.

`cache: false` turns it off for an ask; `cache: '1h'` keeps an Anthropic cache for an hour instead of 5 minutes, written at twice the input price, so it pays off for a prompt reused after more than 5 minutes. Other providers ignore `'1h'`.

`reply.usage` then has `cacheReadTokens` and `cacheWriteTokens` when the provider reported them. `inputTokens` is only the input read at full price: OpenAI's cached tokens are taken out of its `prompt_tokens`, Anthropic's `input_tokens` already leaves them out. The budget counts all of them, [one token each](limits.md#when-it-counts). In tests, a fake script `{ text, cache: { read, written } }` reports them.

## The reply

- `await reply` is the full text; it throws the `AiError` the provider failed with.
- `for await (const text of reply)` yields snapshots, each the text so far; `reply.deltas()` yields the pieces alone.
- `await reply.usage` is `{ inputTokens, outputTokens }`, plus `cacheReadTokens` and `cacheWriteTokens` when the provider reported a cache, or undefined when the provider gave none or the reply failed; it never rejects, and reading it starts the reply.
- `await reply.finish` is why it ended: `stop`, `length` (the `maxTokens` cap, the text returned as it is), `filtered` (the provider's filter or refusal) or `steps` (the tool loop ran out of `maxSteps` with the model still calling tools); undefined when it failed. Check it when a long answer matters.
- `reply.stop()` aborts the provider request, what came staying the text of `await`. A stop is not an error: `await` resolves to the partial text.
- A provider that stalls fails the reply with an `AiError` of kind `timeout`: after 30 s without an answer (`timeout.connect`), or 60 s without a chunk of the stream once it began (`timeout.idle`; `partial` holds what came). Both take a duration (`'10s'`, `500`, seconds), at most about 24 days; each step of a tool loop counts anew.
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

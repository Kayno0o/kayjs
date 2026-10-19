# kayjs-ai: The fake, errors and providers

## The fake

Under `bun test`, and in development until a provider is configured, `ask()` answers from `fakeAi`, as kayjs-mail answers into its `outbox`. A key in the test environment is never used.

```ts
import { ask, fakeAi } from '@kaynooo/kayjs-ai'
import { afterEach, expect, it } from 'bun:test'

afterEach(() => fakeAi.clear())

it('asks for the summary', async () => {
  fakeAi.reply(['It ', 'works'])
  fakeAi.reply(asked => `You sent ${asked.messages.length} messages`)

  expect(await ask('Hi')).toBe('It works')
  expect(fakeAi.last()).toMatchObject({ messages: [{ role: 'user', content: 'Hi' }], model: 'fake' })
})
```

- `fakeAi.reply(script)`: the next ask answers with a text (streamed word by word), an array of pieces, `{ text?, calls: [{ name, input }] }` to call tools, or a function of what was asked returning any of them. A tool loop reads one script per step; a string `input` is sent as the raw arguments, so `'{"title": '` plays a model garbling its JSON. Scripts are used in order; with none left the reply is `Fake reply to: <the last user message>`.
- `fakeAi.fail(error)`: the next ask throws it, an `AiError` say.
- `fakeAi.asked` and `fakeAi.last()`: every ask answered, `{ messages, tools, system, model, maxTokens, temperature }`, recorded when the reply is read. `tools` are those offered (`{ name, description, inputSchema }`, absent when none); a message carries `calls` when the assistant called tools and `results` when it is the turn answering them. `fakeAi.clear()` forgets asks and scripts.
- The fake reports a usage of about four characters per token, and in development paces its pieces so a page visibly streams.
- `site.call(action, input)` on an action returning the reply gives its snapshots.

## Errors

`AiError` has a `kind`, a `status` when the provider answered, `retryAfter` (seconds) on a rate limit and `partial` (the text received) on a failure mid-reply:

| kind | when |
| --- | --- |
| `auth` | 401 or 403: the provider refused the key |
| `rate-limited` | 429, `retryAfter` from `Retry-After` in seconds or as a date; a 429 for no credit left (`insufficient_quota`) is `invalid` |
| `unavailable` | 5xx, or an error event such as Anthropic's `overloaded_error` mid-stream |
| `invalid` | another 4xx: an unknown model, a message it cannot take |
| `network` | the provider could not be reached |
| `timeout` | the provider did not answer, or stopped sending mid-reply, for longer than the `timeout` of `ask` |
| `cut` | the stream ended before the provider said it was done |
| `limited` | a limit or budget set in `ai()` refused the ask: `retryAfter` and `limit` (`asks`, `budget`, `total`), see [limits](limits.md) |
| `too-long` | the messages are over the `maxInputChars` of `ask` (50,000 characters): nothing was sent, an action answers 413 |
| `protocol` | an event that is not JSON of the provider's API, or a server answering JSON instead of streaming |

Messages name the provider and what it said, with the key hidden if the provider echoes it. Redirects are refused (`network`), so a key never follows one to another origin. Nothing retries: a caller wanting to waits `retryAfter` and asks again. An action letting the error out answers 500 and logs it, except a `limited` one, which answers 429 with `Retry-After`, and a `too-long` one, which answers 413; catch it to answer the visitor in words.

## Providers by hand

`openai({ baseUrl, apiKey, model })` and `anthropic({ apiKey, baseUrl, model })` build the providers the environment would, for `ask(..., { provider })`: a second model from another server, or a test against a local fake server speaking either API's SSE. A `Provider` is `{ name, model?, stream(request, signal) }`, `stream` an async iterable of `{ text }`, `{ usage }`, `{ finish }` and, when `request.tools` are offered, `{ toolUse: { id, name, arguments } }` pieces (`arguments` the raw JSON text the model wrote) that stops when `signal` aborts.

OpenAI's own server gets `max_completion_tokens`; any other base URL gets `max_tokens`, the name the servers imitating the API know. Both request `stream_options.include_usage` to count tokens; a server answering 400 or 422 to it (Mistral does) is asked again without it, once per process and base URL, and its own `usage` chunk is read. `prompt_cache_key` ([caching](asking.md#prompt-caching)) is dropped the same way, only the parameter the error names when it names one. A `finish_reason` of `error` fails the reply with `unavailable`; array content keeps its `text` chunks.

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

- `fakeAi.reply(script)`: the next ask answers with a text (streamed word by word), an array of pieces, or a function of what was asked returning either. Scripts are used in order; with none left the reply is `Fake reply to: <the last user message>`.
- `fakeAi.fail(error)`: the next ask throws it, an `AiError` say.
- `fakeAi.asked` and `fakeAi.last()`: every ask answered, `{ messages, system, model, maxTokens, temperature }`, recorded when the reply is read. `fakeAi.clear()` forgets asks and scripts.
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
| `cut` | the stream ended before the provider said it was done |
| `protocol` | an event that is not JSON of the provider's API, or a server answering JSON instead of streaming |

Messages name the provider and what it said, with the key hidden if the provider echoes it. Redirects are refused (`network`), so a key never follows one to another origin. Nothing retries: a caller wanting to waits `retryAfter` and asks again. An action letting the error out answers 500 and logs it; catch it to answer the visitor in words.

## Providers by hand

`openai({ baseUrl, apiKey, model })` and `anthropic({ apiKey, baseUrl, model })` build the providers the environment would, for `ask(..., { provider })`: a second model from another server, or a test against a local fake server speaking either API's SSE. A `Provider` is `{ name, model?, stream(request, signal) }`, `stream` an async iterable of `{ text }` and `{ usage }` pieces that stops when `signal` aborts.

OpenAI's own server gets `max_completion_tokens`; any other base URL gets `max_tokens`, the name the servers imitating the API know. Both request `stream_options.include_usage`.

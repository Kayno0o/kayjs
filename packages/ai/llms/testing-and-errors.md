# kayjs-ai: The fake, errors and providers

## Common tasks

### The fake

Under `bun test`, and in development until a provider is configured, `ask()` answers from `fakeAi`, as kayjs-mail answers into its `outbox`. A key in the test environment is never used.

```ts
import { ask } from '@kaynooo/kayjs-ai'
import { aiTest } from '@kaynooo/kayjs-ai/test'
import { expect, it } from 'bun:test'

const model = aiTest()

it('asks for the summary', async () => {
  model.reply(['It ', 'works'])
  model.reply(asked => `You sent ${asked.messages.length} messages`)

  expect(await ask('Hi')).toBe('It works')
  expect(model.last()).toMatchObject({ messages: [{ role: 'user', content: 'Hi' }], model: 'fake' })
})
```

`aiTest()` scripts and reads `fakeAi`, which forgets its scripts and asks at the start of every test, so no test clears it by hand; call it at the top of a file. It has `reply`, `fail`, `asked` and `last()`, which the bullets below describe on `fakeAi`, the process's own, whose `clear()` stays for a test outside `bun test`'s hooks.

## Reference

### The fake's rules

- `fakeAi.reply(script)`: the next ask answers with a text (streamed word by word), an array of pieces, `{ text?, data?, calls: [{ name, input, id? }], cache?, finish? }`: `data` is the object answering an ask with a `schema`, sent as its JSON text in pieces, and any value, so `data: { title: 'x' }` plays a model giving a field short; `calls` call tools (`id` is the call's id, `fake_1`, `fake_2` and so on by default), `cache: { read?, written? }` reports input tokens read from and written to the provider's prompt cache, and `finish` says why the step ended, `stop` by default, `length` for a reply cut by the token cap (also `filtered` and `steps`). A script can also be a function of what was asked returning any of them. A tool loop reads one script per step; a string `input` is sent as the raw arguments, so `'{"title": '` plays a model garbling its JSON. Scripts are used in order; with none left the reply is `Fake reply to: <the last user message>`, or for an ask with a `schema` an object that fits it (`fake` for a string, the minimum for a number, the first choice of an enum, the fields it requires), so `kay dev` needs no key.
- `fakeAi.fail(error)`: the next ask throws it, an `AiError` say.
- `fakeAi.asked` and `fakeAi.last()`: every ask answered, `{ messages, tools, system, model, maxTokens, temperature, schema }`, recorded when the reply is read. `tools` are those offered (`{ name, description, inputSchema }`, absent when none), `schema` the JSON Schema of the object asked for (absent for text); a message carries `calls` when the assistant called tools and `results` when it is the turn answering them. `fakeAi.clear()` forgets asks and scripts.
- The fake reports a usage of about four characters per token, and in development paces its pieces so a page visibly streams.
- `site.call(action, input)` on an action returning the reply gives its snapshots.
- Under `bun test` `ask()` always answers from `fakeAi`, whatever keys the environment holds; in development it does until `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `AI_BASE_URL` is set. Production with none of them throws.

### Errors

`AiError` has a `kind` (also its `code`), a `status` when the provider answered, `retryAfter` (seconds) on a rate limit, `partial` (the text received) on a failure mid-reply and `fields` on a `schema` one:

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
| `schema` | the answer of an ask with a `schema` does not fit it: no JSON object, cut by `maxTokens`, refused, or fields the schema refuses (`fields`, with `partial` the text), see [an object instead of text](asking.md#an-object-instead-of-text) |
| `protocol` | an event that is not JSON of the provider's API, or a server answering JSON instead of streaming |

Messages name the provider and what it said, with the key hidden if the provider echoes it. Redirects are refused (`network`), so a key never follows one to another origin. Nothing retries: a caller wanting to waits `retryAfter` and asks again. An action letting the error out answers 500 and logs it, except a `limited` one, which answers 429 with `Retry-After`, and a `too-long` one, which answers 413; catch it to answer the visitor in words.

### Providers by hand

`openai({ baseUrl, apiKey, model })` and `anthropic({ apiKey, baseUrl, model })` build the providers the environment would, for `ask(..., { provider })`: a second model from another server, or a test against a local fake server speaking either API's SSE. A `Provider` is `{ name, model?, stream(request, signal) }`, `stream` an async iterable of `{ text }`, `{ usage }`, `{ finish }` and, when `request.tools` are offered, `{ toolUse: { id, name, arguments } }` pieces (`arguments` the raw JSON text the model wrote) that stops when `signal` aborts. When `request.schema` (a JSON Schema) is set, the provider asks the model for that object its own way and streams the JSON as `text`; `{ restart: true }` is sent by the tool loop, not by a provider.

OpenAI's own server gets `max_completion_tokens`; any other base URL gets `max_tokens`, the name the servers imitating the API know. Both request `stream_options.include_usage` to count tokens; a server answering 400 or 422 to it (Mistral does) is asked again without it, once per process and base URL, and its own `usage` chunk is read. `prompt_cache_key` ([caching](asking.md#prompt-caching)) is dropped the same way, only the parameter the error names when it names one. A `finish_reason` of `error` fails the reply with `unavailable`; array content keeps its `text` chunks.

## The dev tool tab

Under `kay dev`, `ai()` in `extensions` adds an AI tab to the dev tool with no declaration: the provider and model `ask` would use now (or why none can be chosen), the limit and budget set, and the last 50 asks since the server started, newest first, with the start of the prompt, tokens, milliseconds and the outcome (`ok`, `failed` with its message, `stopped`, `refused` by a limit). It reads `/_kay/ai`, mounted by `kay dev` alone; production and `bun test` record nothing. Without `ai()` there is no tab.

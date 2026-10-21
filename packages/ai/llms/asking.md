# kayjs-ai: Environment, ask() and its reply

## Common tasks

### Set up

`kay add ai` installs the package and lists it in `kay.config.ts`. `ask` works without that, but only `ai()` lists the variables in `kay env`, applies `rateLimit`/`budget`/`key` and adds `kay i18n translate`; without it `ask` is unlimited.

```ts
// kay.config.ts
import { ai } from '@kaynooo/kayjs-ai'

export default defineConfig({ extensions: [ai()] })
```

### ask

```ts
import { ask } from '@kaynooo/kayjs-ai'

ask('Why is the sky blue?')
ask([{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Again' }], { system: 'Answer in French', maxTokens: 500 })
```

`ask(prompt | messages, options?)` returns a `Reply` at once. A prompt is one user message; messages are `{ role: 'user' | 'assistant', content: string }`, other fields dropped.

### An object instead of text

```ts
import { ask } from '@kaynooo/kayjs-ai'
import { s } from 'kay'

const review = s.Object({ title: s.String(), score: s.Integer({ minimum: 1, maximum: 5 }), tags: s.Array(s.String()) })
const verdict = await ask('Review the film Alien', { schema: review })
```

`ask(messages, { schema })` takes an object schema (`s.Object`; anything else throws a `config-invalid` `KayError`, an `s.Record` or `s.Intersect` field too, as a model cannot be held to free keys: name the fields) and returns a `StructuredReply` instead of a `Reply`: `await` is the value the schema describes, `Static<typeof review>`, with no cast, and `for await` gives the object so far, a `DeepPartial` of it. Nothing is sent until it is first read, and readers share one request, as with text.

### In a page

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

### From an island

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

## Reference

### Environment

- `ANTHROPIC_API_KEY`: Anthropic's Messages API.
- `OPENAI_API_KEY`: OpenAI's chat completions at `https://api.openai.com/v1`.
- `AI_BASE_URL`: an OpenAI-compatible server's API root, `http://localhost:11434/v1` for Ollama; its key, when it wants one, is `OPENAI_API_KEY`. With `AI_PROVIDER=anthropic` it is a proxy's root for Anthropic instead.
- `AI_MODEL`: the default model, `ask(..., { model })` overrides it. Required in production, which `kay env` shows as such once `ai()` is in `extensions`.
- `AI_PROVIDER` (`anthropic` or `openai`): only needed when both keys are set, as `ask` throws rather than pick an account to bill.

Mistral: `AI_BASE_URL=https://api.mistral.ai/v1`, its key in `OPENAI_API_KEY`, `AI_MODEL=mistral-small-2603`. Pin a dated model id: an alias such as `mistral-small-latest` moves to the next model and bills at its price. Nothing else is set: kay drops the `stream_options` Mistral refuses, reads its array content for the text, and counts the usage it sends unasked.

The provider is `AI_BASE_URL` when set, else the one key set. Nothing is read at import: a missing variable throws at the `ask()` call, naming what to set, and never while `kay build` runs.

### ask options

- Options: `system`, `model`, `maxTokens` (4096 by default, as Anthropic requires one), `temperature`, `cache`, `signal`, `timeout`, `key` (who the ask counts against, [limits](limits.md)), `tools`, `maxSteps` and `confirm` ([Actions as tools](tools.md)), `maxInputChars` (50,000, [limits](limits.md#the-size-of-the-input)), `schema` ([an object instead of text](#an-object-instead-of-text)) and `provider` to ask a provider built by hand.
- `ask()` runs on the server, where the key lives: call it in a `--- server` fence, an action, a job or an API route. An island importing it fails `kay build`, which is how the key stays out of the browser. Reach it from an island through an action.
- Messages are `user` and `assistant` only; the system prompt goes in `options.system`. A history a visitor posts can never carry a system prompt, and a `system` role throws.
- No model id is built in: set `AI_MODEL` (required in production) or pass `{ model }`.

### Structured answers

- Each provider is asked through its own JSON-schema output, so the model writes to the shape: Anthropic gets `output_config.format` (`json_schema`, which the model must support, else the 400 is an `invalid` error), an OpenAI-compatible server (OpenAI, Ollama, Mistral) gets `response_format` of type `json_schema`, strict when every field is required. A server answering 400 or 422 that names `response_format` is asked again with a tool call it is forced to make (`kay_answer`, `tool_choice: 'required'`), whose arguments are streamed as the text, remembered per process and base URL once that call works (an error about an invalid schema is no such answer). A provider by hand reads `request.schema` and streams the JSON as `text` pieces.
- What those outputs cannot hold (`minLength`, `maximum`, `pattern`, `format`, `minItems`, `default`) is not sent as a rule: the field's description carries it as `{minLength: 3}` for the model, every object is closed to other fields, and kayjs-ai checks the answer against your whole schema, without stripping the fields it does not name: pick the fields you use rather than spreading the answer.
- The answer must be the JSON object alone. One that is not JSON, has text around it, was cut by `maxTokens`, was refused (`filtered`) or ran out of `maxSteps` still calling tools, or that the schema refuses, fails the reply with an `AiError` of kind `schema`: `fields` names each field that does not fit (`author.name`, `tags[1]`, empty when the answer is no object), `partial` holds the text and the message says why. `usage`, `finish` and `calls` still resolve, and the tokens still count.
- A snapshot holds a string field as far as it has come (an enum or literal is typed `string` there, as `'sp'` comes before `'spam'`) and any other field once complete: a number, a boolean or an array item shows when it ends, a nested object or array as it stands. Every field of a snapshot is optional in its type, and the last one `for await` gives is the checked value. A snapshot is not checked against the schema, only the end is.
- `reply.deltas()` gives the JSON text in pieces; when a step wrote text and then called tools that text is dropped, which `reply.deltas({ onRestart })` announces by calling `onRestart` before the first piece of the answer, so a reader that clears what it kept ends with the JSON answered (a snapshot reader just sees the text start over). `usage`, `finish`, `calls` and `stop()` are the reply's own; `progress()` is not offered. `stop()` ends the request, and `await` then fails with a `schema` error as the cut text is no whole object.
- `tools`, `maxSteps`, `confirm`, limits, the budget and `maxInputChars` work as without a schema; the schema counts for the tokens held against the budget. With tools, only the text of the step that answered is the object: a step that wrote text and then called tools drops it. The tools and the format go in one request; on the forced call, `kay_answer` is offered beside the tools.
- An action returning the reply streams the snapshots to the island, whose `last()` is the object so far; an `async` handler returning it awaits it and answers the checked value, so it returns `.stream()` instead (`async-reply`). A plain form post or an MCP call gets the last snapshot.

### Prompt caching

On by default, so a chat does not pay full price for its system prompt, tools and history on every turn and tool step. Anthropic gets the top-level `cache_control: { type: 'ephemeral' }` (automatic caching: the breakpoint moves to the last cacheable block); a prompt under the model's minimum is simply not cached. An OpenAI-compatible server gets a `prompt_cache_key`, a hash of the system prompt and the first message, so every turn and tool step of a conversation shares one key and no two conversations do. It caches long prompts on its own either way. A server refusing the key (400 or 422, Ollama or a strict gateway) is asked again without it, once per process and base URL, with nothing set.

`cache: false` turns it off for an ask; `cache: '1h'` keeps an Anthropic cache for an hour instead of 5 minutes, written at twice the input price, so it pays off for a prompt reused after more than 5 minutes. Other providers ignore `'1h'`.

`reply.usage` then has `cacheReadTokens` and `cacheWriteTokens` when the provider reported them. `inputTokens` is only the input read at full price: OpenAI's cached tokens are taken out of its `prompt_tokens`, Anthropic's `input_tokens` already leaves them out. The budget counts all of them, [one token each](limits.md#when-it-counts). In tests, a fake script `{ text, cache: { read, written } }` reports them.

### The reply

- `await reply` is the full text; it throws the `AiError` the provider failed with.
- `for await (const text of reply)` yields snapshots, each the text so far; `reply.deltas()` yields the pieces alone; `reply.stream()` yields the snapshots in an object that is no thenable, for an `async` handler to return.
- `await reply.usage` is `{ inputTokens, outputTokens }`, plus `cacheReadTokens` and `cacheWriteTokens` when the provider reported a cache, or undefined when the provider gave none or the reply failed; it never rejects, and reading it starts the reply.
- `await reply.finish` is why it ended: `stop`, `length` (the `maxTokens` cap, the text returned as it is), `filtered` (the provider's filter or refusal) or `steps` (the tool loop ran out of `maxSteps` with the model still calling tools); undefined when it failed. Check it when a long answer matters.
- `reply.stop()` aborts the provider request, what came staying the text of `await`. A stop is not an error: `await` resolves to the partial text.
- A provider that stalls fails the reply with an `AiError` of kind `timeout`: after 30 s without an answer (`timeout.connect`), or 60 s without a chunk of the stream once it began (`timeout.idle`; `partial` holds what came). Both take a duration (`'10s'`, `'500ms'`), at most about 24 days; each step of a tool loop counts anew.
- All readers share one request, which starts on the first read. The request being answered aborting, `options.signal` aborting or a reader leaving early stops it.

- The reply is a thenable async iterable, not a Promise: `await ask(...)` is the full text, `for await` gives snapshots (the text so far), and an `await` block or a plain-arrow handler returning it streams; an `async` handler returns `ask(...).stream()` (lint `async-reply`).
- Nothing is sent until the reply is first read, so an `await ask()` an island's server render skips bills nothing. A reader leaving early, the visitor leaving the page, or `options.signal` aborts the provider request.
- A failure is an `AiError` with a `kind`; nothing retries by itself. A rate limit carries `retryAfter` in seconds. A reply cut by `maxTokens` still resolves as text: read `await reply.finish` (`length`) to tell.

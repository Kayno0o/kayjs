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

`ask(prompt | messages, options?)` returns a `Reply` at once. A prompt is one user message; messages are `{ role: 'user' | 'assistant', content: string }`, other fields dropped.  A user message may also hold `attachments`, images and PDFs ([Images and PDFs](attachments.md)).

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
import { ask, chatMessages } from '@kaynooo/kayjs-ai'

export const reply = action(s.Object({ messages: chatMessages() }), ({ messages }) => ask(messages, { system: 'You answer for the shop' }))
---
p Chat
```

In the island, `const stream = await reply({ messages })` resolves with an `ActionStream` whose `last()` is the text so far. Bound the history in the schema (`chatMessages({ maxItems, maxLength })` is the one Chat posts: [Chat](chat.md)) and rate limit the action: each call bills.

## Reference

### Environment

- `ANTHROPIC_API_KEY`: Anthropic's Messages API.
- `OPENAI_API_KEY`: OpenAI's chat completions at `https://api.openai.com/v1`.
- `AI_BASE_URL`: an OpenAI-compatible server's API root, `http://localhost:11434/v1` for Ollama; its key, when it wants one, is `OPENAI_API_KEY`. With `AI_PROVIDER=anthropic` it is a proxy's root for Anthropic instead.
- `AI_MODEL`: the default model, `ask(..., { model })` overrides it. Required in production, which `kay env` shows as such once `ai()` is in `extensions`.
- `AI_PROVIDER` (`anthropic` or `openai`): only needed when both keys are set, as `ask` throws rather than pick an account to bill.

Mistral: `AI_BASE_URL=https://api.mistral.ai/v1`, its key in `OPENAI_API_KEY`, `AI_MODEL=mistral-small-2603`. Pin a dated model id: an alias such as `mistral-small-latest` moves to the next model and bills at its price. Nothing else is set: kay drops the `stream_options` Mistral refuses, reads its array content for the text, and counts the usage it sends unasked.

`transcribe()`, `speak()` and `embed()` read their own variables (`AI_AUDIO_URL`, `AI_EMBED_URL`, a model each, `AI_VOICE`): [Speech and embeddings](speech-and-embeddings.md).

Every API root (`AI_BASE_URL`, `AI_AUDIO_URL`, `AI_EMBED_URL`, `baseUrl`) must be an http(s) URL: one that does not parse, or has no scheme, throws naming the variable: `openai({ baseUrl })` and `anthropic({ baseUrl })` when called, an environment root at the first `ask()`, `embed()`, `speak()` or `transcribe()`. A key goes over plain http only to a loopback host (`localhost`, `127.0.0.1`, `[::1]`); a network you trust, such as a compose network, needs `AI_INSECURE=true` (`insecure: true` on `openai()` and `anthropic()`). `AI_PROVIDER=openai` without `OPENAI_API_KEY` throws too, unless `AI_BASE_URL` names a compatible server.

The provider is `AI_BASE_URL` when set, else the one key set. Nothing is read at import: a missing variable throws at the `ask()` call, naming what to set, and never while `kay build` runs.

### ask options

- Options: `system`, `model`, `maxTokens` (4096 by default, as Anthropic requires one), `temperature`, `reasoning`, `cache`, `body` ([fields kayjs-ai does not model](#fields-kayjs-ai-does-not-model)), `signal`, `sources` ([cited documents](chat-sources.md)), `outlive` ([a reply that finishes after the visitor left](#a-reply-that-outlives-the-visitor)), `timeout`, `key` (who the ask counts against, [limits](limits.md)), `tools`, `maxSteps` and `confirm` ([Actions as tools](tools.md)), `maxInputChars` (50,000, [limits](limits.md#the-size-of-the-input)), `maxAttachmentBytes` (10 MB, [images and PDFs](attachments.md)), `schema` ([an object instead of text](#an-object-instead-of-text)) and `provider` to ask a provider built by hand.
- `reasoning` (`'none'`, `'low'`, `'medium'` or `'high'`) turns a reasoning model's thinking down, such as `'none'` for a one-sentence reply in about a second instead of ten: an OpenAI-compatible server (OpenAI, Ollama, Mistral) gets it as `reasoning_effort` only when you pass it, and one refusing the field with a 400 or 422 is asked again without it, remembered per process and base URL; Anthropic gets adaptive thinking: `'low'`, `'medium'` and `'high'` send `thinking: { type: 'adaptive', display: 'summarized' }` with `output_config.effort` of that level (the display makes the models since 4.7 stream their thinking text instead of omitting it), and the `temperature` is left out then, as Anthropic refuses one while the model thinks. `'none'` sends effort `low` with `thinking: { type: 'disabled' }`; a model whose 400 or 422 names `disabled` or the effort is asked again without that part, remembered per process, API root and model once the retry gets through (Haiku 4.5 and Sonnet 4.5 take no effort, so `none` is sent without it there); any other refusal is surfaced as it is and remembers nothing. A level refused for its thinking or effort fails with an error naming `reasoning` and `body: { thinking }`, the way out for such a model. A `thinking` in `body` replaces all of it, effort included, for a model that still wants `{ type: 'enabled', budget_tokens }` (Haiku 4.5 and older). Models since 4.7 also refuse any `temperature`, `top_p` or `top_k` you set, with their own message.
- What a model thinks streams as its own piece: `reply.progress()` carries it as `reasoning` (Anthropic's thinking blocks, a server's `reasoning_content` or OpenRouter's `reasoning`), and `await reply` never holds it. In a tool loop Anthropic's thinking blocks, signed, go back with the calls of their step as its API requires; the reasoning of later blocks and steps follows the first after a blank line, and a step whose thinking passes 262,144 characters fails the reply with a `protocol` error.
- `ask()` runs on the server, where the key lives: call it in a `--- server` fence, an action, a job or an API route. An island importing it fails `kay build`, which is how the key stays out of the browser. Reach it from an island through an action.
- Messages are `user` and `assistant` only; the system prompt goes in `options.system`. A history a visitor posts can never carry a system prompt, and a `system` role throws.
- No model id is built in: set `AI_MODEL` (required in production) or pass `{ model }`.

### Fields kayjs-ai does not model

- `ask(..., { body: { top_p: 0.9, seed: 7, stop: ['END'] } })` adds those fields to the provider's request body as they are, so a parameter a provider takes (`top_p`, `seed`, `presence_penalty`, Mistral's `safe_prompt`, Anthropic's `top_k` or `metadata.user_id`, OpenRouter's `provider` routing) needs no kayjs-ai release. `openai({ baseUrl, body })` and `anthropic({ apiKey, body })` set fields once for every ask of that provider; the ask's own `body` wins field by field, top level only.
- What kayjs-ai settles wins over both, so a stray field cannot break the reply: `model`, `messages`, `stream`, `tools`, the token limit, the schema's output format, and `temperature`, `reasoning` and `cache` when the ask gives them (a body `temperature` is sent when `temperature` is not).
- A server refusing a field fails the reply with its own message (`invalid`, with the server's words). Only the parameters kayjs-ai adds itself are dropped and retried; a field from `body` is never.

### Structured answers

- Each provider is asked through its own JSON-schema output, so the model writes to the shape: Anthropic gets `output_config.format` (`json_schema`, which the model must support, else the 400 is an `invalid` error), an OpenAI-compatible server (OpenAI, Ollama, Mistral) gets `response_format` of type `json_schema`, strict when every field is required. A server answering 400 or 422 that names `response_format` is asked again with a tool call it is forced to make (`kay_answer`, `tool_choice: 'required'`), whose arguments are streamed as the text, remembered per process and base URL once that call works (an error about an invalid schema is no such answer). A provider by hand reads `request.schema` and streams the JSON as `text` pieces.
- What those outputs cannot hold (`minLength`, `maximum`, `pattern`, `format`, `minItems`, `default`) is not sent as a rule: the field's description carries it as `{minLength: 3}` for the model, every object is closed to other fields, and kayjs-ai checks the answer against your whole schema, without stripping the fields it does not name: pick the fields you use rather than spreading the answer.
- The answer must be the JSON object alone. One that is not JSON, has text around it, was cut by `maxTokens`, was refused (`filtered`) or ran out of `maxSteps` still calling tools, or that the schema refuses, fails the reply with an `AiError` of kind `schema`: `fields` names each field that does not fit (`author.name`, `tags[1]`, empty when the answer is no object), `partial` holds the text and the message says why. `usage`, `finish` and `calls` still resolve, and the tokens still count.
- A snapshot holds a string field as far as it has come (an enum or literal is typed `string` there, as `'sp'` comes before `'spam'`) and any other field once complete: a number, a boolean or an array item shows when it ends, a nested object or array as it stands. Every field of a snapshot is optional in its type, and the last one `for await` gives is the checked value. A snapshot is not checked against the schema, only the end is.
- `reply.deltas()` gives the JSON text in pieces; when a step wrote text and then called tools that text is dropped, which `reply.deltas({ onRestart })` announces by calling `onRestart` before the first piece of the answer, so a reader that clears what it kept ends with the JSON answered (a snapshot reader just sees the text start over). `usage`, `finish`, `calls` and `stop()` are the reply's own; `progress()` is not offered. `stop()` ends the request, and `await` then fails with a `schema` error as the cut text is no whole object.
- `tools`, `maxSteps`, `confirm`, limits, the budget and `maxInputChars` work as without a schema; the schema counts for the tokens held against the budget. With tools, only the text of the step that answered is the object: a step that wrote text and then called tools drops it. The tools and the format go in one request; on the forced call, `kay_answer` is offered beside the tools.
- An action returning the reply streams the snapshots to the island, whose `last()` is the object so far; an `async` handler returning it awaits it and answers the checked value, so it returns `.stream()` instead (`async-reply`). A plain form post or an MCP call gets the last snapshot.

### A reply that outlives the visitor

A reply is stopped when the request being answered aborts, as a reload or a closed tab does, which is right for a paid public chat. An app on a local model, or one whose tools act on the world (a light switched, a message sent, an answer read aloud by the server), wants it to finish: `ask(messages, { outlive: true })`.

- The provider request, the tool loop and every server reader (the app's own `for await`) go on after the request aborts, so the tools after the abort run and the text is whole for a reader that kept going. `reply.stop()` and `options.signal` still stop it. A reader leaving early no longer does: it only stops reading, so a `break` out of a `for await` leaves the reply running.
- The budget and the rate limit count the reply as any other: its tokens are counted once it ends, as the request is, and a reply refused by a limit is refused.
- `Chat` with `remember` shows the finished turn after a reload with no app code, or picks the stream back up if the reply is still under way: [Chat](chat.md#a-reply-that-outlives-the-page).
- The reply is kept in this process's memory only, for half an hour and 200 at most (finished ones go first, oldest first), so a restart loses it and a second server process does not find it. It is kept for the action that asked and the visitor (the signed-in user, else the address, as the limits count them): an id replayed against another action or by another visitor gets an empty reply and cannot stop it, and a visitor with neither a user nor an address (no socket) keeps no reply. Two `ask()` calls in one action keep two replies, told apart by their order in the call, so the action makes the same `ask()` calls in the same order for a start, a resume and a stop: an `ask()` made only on some of them shifts the others' places and the resume finds nothing.
- A resume or a stop asks no provider and counts nothing in `ai({ budget, rateLimit })`; the action's own `protect.rateLimit` counts the call first, as kay runs it before the handler, and gives that attempt back once `ask` finds the reply the same visitor kept for the same action, so reloading a page does not spend the limit. A resume of nothing, of another visitor's reply, a header on an action that never asks and an ordinary ask stay counted, as does a limit with `count: 'succeeded'` and a `RateStore` without `refund`. Only the first 3 resumes and stops of one kept reply give theirs back, counted in the process that keeps it, so the rest stay counted and one kept reply cannot replay the handler's code before `ask` without limit.
- A resume or a stop runs the action again from its top, and `ask()` hands back the kept reply or an empty one, so what the action does on the server around it happens again. `reply.resumed` is true on that reply (and on a schema reply), and `resuming()` from `kayjs-ai` tells it before `ask`: `const answer = ask(messages, { outlive: true })` then `if (!answer.resumed) void speak(answer)` reads it once, and `if (resuming()) return ask(messages, { outlive: true })` after loading nothing skips what only a start needs. Both are false for a start and for an ordinary ask; `resuming()` is also true for the reads and changes a `Chat` with `keepOnServer` posts, which `ask` answers with no model asked ([Conversations kept on the server](chat-conversations.md)).
- Without `outlive` a reload mid-reply loses the reply, and a tool call already running finishes with its result dropped.

### Prompt caching

On by default, so a chat does not pay full price for its system prompt, tools and history on every turn and tool step. Anthropic gets the top-level `cache_control: { type: 'ephemeral' }` (automatic caching: the breakpoint moves to the last cacheable block); a prompt under the model's minimum is simply not cached. An OpenAI-compatible server gets a `prompt_cache_key`, a hash of the system prompt and the first message, so every turn and tool step of a conversation shares one key and no two conversations do. It caches long prompts on its own either way. A server refusing the key (400 or 422, Ollama or a strict gateway) is asked again without it, once per process and base URL, with nothing set.

`cache: false` turns it off for an ask; `cache: '1h'` keeps an Anthropic cache for an hour instead of 5 minutes, written at twice the input price, so it pays off for a prompt reused after more than 5 minutes. Other providers ignore `'1h'`.

`reply.usage` then has `cacheReadTokens` and `cacheWriteTokens` when the provider reported them. `inputTokens` is only the input read at full price: OpenAI's cached tokens are taken out of its `prompt_tokens`, Anthropic's `input_tokens` already leaves them out. The budget counts all of them, [one token each](limits.md#when-it-counts). In tests, a fake script `{ text, cache: { read, written } }` reports them.

### The reply

- `await reply` is the full text; it throws the `AiError` the provider failed with.
- `for await (const text of reply)` yields snapshots, each the text so far; `reply.deltas()` yields the pieces alone; `reply.stream()` yields the snapshots in an object that is no thenable, for an `async` handler to return.
- `await reply.usage` is `{ inputTokens, outputTokens }`, plus `cacheReadTokens` and `cacheWriteTokens` when the provider reported a cache, or undefined when the provider gave none or the reply failed; it never rejects, and reading it starts the reply.
- `await reply.steps` lists the requests made to the model, one per round of a tool loop (one for a reply without tools): `{ ms, firstTokenMs, usage, finish, calls }`, `ms` from sent to the end of the model's answer (the tools it called not counted), `firstTokenMs` the wait for its first text, reasoning or call (undefined when it said nothing), `usage` that request's tokens (estimated in a tool loop when the provider gave none) and `calls` the tool calls it made. It holds the requests that ended, so a failed or stopped reply lists the ones before it, and one stopped while its tools ran ends on that request with the calls that ran; it never rejects, and reading it starts the reply. Each `ToolCall` has its `ms`, how long the call took (a `confirm` the app awaits counts), once it is done: read both to tell a slow model from a slow tool.
- `await reply.finish` is why it ended: `stop`, `length` (the `maxTokens` cap, the text returned as it is), `filtered` (the provider's filter or refusal) or `steps` (the tool loop ran out of `maxSteps` with the model still calling tools); undefined when it failed. Check it when a long answer matters.
- `reply.stop()` aborts the provider request, what came staying the text of `await`. A stop is not an error: `await` resolves to the partial text.
- A provider that stalls fails the reply with an `AiError` of kind `timeout`: after 30 s without an answer (`timeout.connect`), or 60 s without a chunk of the stream once it began (`timeout.idle`; `partial` holds what came). Both take a duration (`'10s'`, `'500ms'`), at most about 24 days; each step of a tool loop counts anew.
- All readers share one request, which starts on the first read. The request being answered aborting, `options.signal` aborting or a reader leaving early stops it, unless the ask [outlives the visitor](#a-reply-that-outlives-the-visitor).

- The reply is a thenable async iterable, not a Promise: `await ask(...)` is the full text, `for await` gives snapshots (the text so far), and an `await` block or a plain-arrow handler returning it streams; an `async` handler returns `ask(...).stream()` (lint `async-reply`).
- Nothing is sent until the reply is first read, so an `await ask()` an island's server render skips bills nothing. A reader leaving early, the visitor leaving the page, or `options.signal` aborts the provider request.
- A failure is an `AiError` with a `kind`; nothing retries by itself. A rate limit carries `retryAfter` in seconds. A reply cut by `maxTokens` still resolves as text: read `await reply.finish` (`length`) to tell.

---
title: kayjs-ai
order: 0
description: Call an LLM from a kay app with no SDK and no streaming code, over Anthropic or any OpenAI-compatible server.
---
`@kaynooo/kayjs-ai` asks a language model from your server code. It talks to the providers over HTTP, so there is no SDK to install, and the answer streams into your page as it is written. In development and tests a fake answers, so nothing is billed and no key is needed.

## Install

```sh
bun add @kaynooo/kayjs-ai
```

The `@kaynooo` scope must point at the Forgejo registry. A project made by `kay new` already has it in its `.npmrc`; for another, see [Installation](/getting-started/installation).

kay is a peer. kayjs-ai is released with kay, at kay's own version, and peers on kay's minor. Install the one matching your kay and move them together.

## Setup

In a kay project, `kay add ai` does the install and the line below for you.

List the extension in `kay.config.ts`. It only makes `kay env` show the variables below; `ask` works without it.

```ts
import { ai } from '@kaynooo/kayjs-ai'

export default defineConfig({
  extensions: [
    ai(),
  ],
})
```

Then pick a provider with environment variables:

- `ANTHROPIC_API_KEY` uses Anthropic.
- `OPENAI_API_KEY` uses OpenAI.
- `AI_BASE_URL` uses any server that speaks the OpenAI API, such as Ollama at `http://localhost:11434/v1`.
- `AI_MODEL` is the model to ask. It is required in production, and no model name is built in.

With both keys set, add `AI_PROVIDER=anthropic` or `openai` to say which one to use. kay stops rather than guess which account to bill.

## Ask in a page

`ask` returns the reply at once and sends nothing until the reply is read. Put it in a `server` fence and give it to an `await` block. The block shows the text as it grows.

```kay
--- server
import { ask } from '@kaynooo/kayjs-ai'

const answer = ask('Say hello in one line', { system: 'Be brief' })
---
await answer
  p Thinking
then text
  p {text}
catch
  p The reply was cut short
```

The visitor leaving the page stops the request to the provider.

## Ask from an island

An island cannot call `ask`, because the key must stay on the server. Importing it in an island fails the build. Call an action instead, and return the reply from it. The action streams it to the island.

```kay
--- server
import { s } from 'kay'
import { ask } from '@kaynooo/kayjs-ai'

export const reply = action(s.Object({ messages: s.Array(s.Object({ role: s.UnionEnum(['user', 'assistant']), content: s.String({ maxLength: 4000 }) }), { minItems: 1, maxItems: 40 }) }), ({ messages }) => ask(messages))
---
p Chat
```

Return the reply from a plain arrow function, as above. An `async` handler waits for the whole text before it answers, so nothing streams.

An action keeps its guards, its schema and its rate limits. Each call bills, so set a limit and keep the history short in the schema.

Messages take only the roles `user` and `assistant`. The system prompt goes in the `system` option, so a visitor can never send one.

## A chat for your site

`Chat` is an island that talks to your action. It keeps the history, streams the reply in as Markdown and has a Stop button. It uses kayjs-ui's look, so import that library's `theme.css` once.

```kay
---
import Chat from '@kaynooo/kayjs-ai/chat.kay'
import { reply } from '../routes/reply.kay'
---
Chat(action={reply} label="Assistant")
```

Put this in a component of your own, such as `assistant.kay`, and use that component in your page. A page with a `server` fence cannot hand an action to an island, but a component can import it.

- Enter sends and Shift+Enter starts a new line.
- Stop, or Escape in the field, ends the reply. The words that came stay, marked as stopped.
- If the call fails, the chat shows an alert and a button to ask again. The message is not sent twice.
- A screen reader hears each finished turn once, not word by word.
- Images in a reply are not shown. A model that read a hostile page could point an image at a link carrying your visitor's conversation.

Every label is a prop, so you can write them in your language: `placeholder`, `sendLabel`, `stopLabel`, `retryLabel`, `thinkingLabel`, `stoppedLabel` and `errorMessage`. A refusal from the action, such as a rate limit's message, shows instead of `errorMessage`. `initial` gives messages to start with.

The chat posts its last 20 messages with each one; the `keep` prop changes that. Keep `maxItems` in the action's schema at least as high as `keep`, bound `content`, and add a rate limit.

<ReadMore href="/llms/kayjs-ai-chat">The props, the markup and the rules for passing the action.</ReadMore>

## The reply

- `await reply` is the whole text.
- `for await (const text of reply)` gives the text so far, again and again.
- `reply.deltas()` gives only the new pieces.
- `await reply.usage` gives the token counts when the reply is over.
- `await reply.finish` says why it ended: `stop`, `length` when the `maxTokens` cap cut it, or `filtered`.
- `reply.stop()` cancels the request. The reply then resolves to the text that came so far, not an error.

A long answer cut by `maxTokens` still resolves as text, so check `finish` when that matters.

kay sets no timeout on the request. A provider that stalls keeps the reply open until your `signal`, `stop()` or the visitor leaving ends it.

`ask` also takes `model`, `maxTokens` (4096 by default), `temperature` and a `signal`.

<ReadMore href="/llms/kayjs-ai-asking">Every variable, how the provider is picked, and the options of `ask`.</ReadMore>

## Errors

A failure throws an `AiError` with a `kind`: `auth`, `rate-limited`, `unavailable`, `invalid`, `network`, `cut` or `protocol`. A rate limit has `retryAfter` in seconds. A reply cut halfway has `partial`, the text that came. Nothing is retried for you.

## Test it

Under `bun test`, `ask` always answers from `fakeAi`, even when a key is set. A test says what the model answers and reads what was asked.

```ts
import { ask, fakeAi } from '@kaynooo/kayjs-ai'

fakeAi.reply(['It ', 'works'])

expect(await ask('Hi')).toBe('It works')
expect(fakeAi.last()?.messages).toEqual([{ role: 'user', content: 'Hi' }])
```

`fakeAi.fail(error)` makes the next ask fail, and `fakeAi.clear()` forgets everything. With nothing scripted, the fake answers `Fake reply to:` followed by your last message. In development the fake answers too, until a provider is configured.

<ReadMore href="/llms/kayjs-ai-testing-and-errors">Scripting the fake, every error kind, and building a provider by hand.</ReadMore>

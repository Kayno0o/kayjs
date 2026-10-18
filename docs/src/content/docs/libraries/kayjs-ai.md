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

For Mistral, set `AI_BASE_URL=https://api.mistral.ai/v1`, put its key in `OPENAI_API_KEY` and set `AI_MODEL` to a dated model such as `mistral-small-2603`. Avoid an alias like `mistral-small-latest`: it moves to the next model, and you pay that model's price. Nothing else is needed.

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

A page, with or without a `server` fence, hands the action straight to `Chat`. The action has to be exported by a page or endpoint.

- Enter sends and Shift+Enter starts a new line.
- Stop, or Escape in the field, ends the reply. The words that came stay, marked as stopped. Stopped before the first word, the message goes back to the field.
- A screen reader hears each finished turn once, not word by word, and each tool call as it starts and ends.
- A table wider than its bubble scrolls sideways inside it, and the keyboard can scroll it.
- A message the action's schema refuses (422) goes back to the field, also when it was a retry, and the refusal's message shows.
- A link in a reply opens in a new tab, so following it never loses the conversation; `links="here"` opens a link to your own site in place, which `ChatLauncher` sets.
- Images in a reply are not shown. A model that read a hostile page could point an image at a link carrying your visitor's conversation.

Every label is a prop, so you can write them in your language: `placeholder`, `sendLabel`, `stopLabel`, `retryLabel`, `thinkingLabel`, `stoppedLabel`, `tableLabel` (a reply with several tables numbers them) and `errorMessage`. The action may also `ctx.fail`. A refusal from the action, such as a rate limit's message, shows instead of `errorMessage`. `initial` gives messages to start with.

The chat posts its last 20 messages with each one; the `keep` prop changes that, and what is posted always opens on one of the visitor's, so an assistant greeting in `initial` is never the first message. Keep `maxItems` in the action's schema at least as high as `keep`, bound `content`, and add a rate limit.

<ReadMore href="/llms/kayjs-ai-chat">The props, the markup and the rules for passing the action.</ReadMore>

### A chat button on every page

`ChatLauncher` is the same chat behind a round button at the bottom right of the page, which opens it in a panel. Put it once in the root layout, in a `server` fence that gives it the action, and every page has the chat:

```kay
--- server
import { reply } from './reply.kay'
--- script
import ChatLauncher from '@kaynooo/kayjs-ai/chat-launcher.kay'
---
slot
ChatLauncher(action={reply} label="Ask the docs")
```

The chat's code loads the first time the panel opens, so a visitor who never opens it downloads the button and nothing more. The panel stays open across pages, with the conversation in it, and a link in an answer to a page of your site opens in place instead of in a new tab. A reload of the tab finds the conversation again, kept in the tab's session storage.

The button works from the keyboard: Enter or Space opens the panel and puts the focus in the field, and Escape closes it and gives the focus back to the button. A reply under way stops on the first Escape.

`openLabel` names the button and `closeLabel` its close button, `@icon` and `@closeIcon` replace the two icons, and `@note` adds a line under the chat. The other props are `Chat`'s. The button has a `data-tooltip`, which shows when the layout renders kayjs-ui's `TooltipHost`.

The conversation is kept in the tab's session storage under the `remember` prop (`kai-chat`), so on a site with sign-in, give it a key per visitor or clear it when they sign out.

## The reply

- `await reply` is the whole text.
- `for await (const text of reply)` gives the text so far, again and again.
- `reply.deltas()` gives only the new pieces.
- `await reply.usage` gives the token counts when the reply is over, with `cacheReadTokens` and `cacheWriteTokens` when the provider reported a prompt cache.
- `await reply.finish` says why it ended: `stop`, `length` when the `maxTokens` cap cut it, `filtered`, or `steps` when the model was still calling tools after `maxSteps`.
- `reply.stop()` cancels the request. The reply then resolves to the text that came so far, not an error.

A long answer cut by `maxTokens` still resolves as text, so check `finish` when that matters.

A provider that stalls fails the reply with an `AiError` of kind `timeout`. kay waits 30 seconds for the provider to start answering, and 60 seconds for the next piece of a reply that began. Change either per call with `timeout: { connect: '10s', idle: '20s' }`, a duration as elsewhere in kay.

`ask` also takes `model`, `maxTokens` (4096 by default), `temperature` and a `signal`.

<ReadMore href="/llms/kayjs-ai-asking">Every variable, how the provider is picked, and the options of `ask`.</ReadMore>

## Prompt caching

Providers bill a repeated prompt at a fraction of the price when they cached it. kayjs-ai asks for that on every `ask`, so a chat does not pay full price for its system prompt, tools and earlier messages on each turn and each tool step. You set nothing. A prompt shorter than the provider's minimum is simply not cached.

Pass `cache: false` to turn it off for one ask. Pass `cache: '1h'` to keep an Anthropic cache for an hour instead of 5 minutes, which costs more to write and pays off when the same prompt comes back after a longer gap.

With an OpenAI-compatible server, kay sends a `prompt_cache_key` that is the same for every turn of a conversation. A server that refuses the key, such as Ollama, is asked again without it, and kay remembers that for the rest of the run.

`await reply.usage` then holds `cacheReadTokens` and `cacheWriteTokens`. `inputTokens` is only the input that was neither read from the cache nor written to it. In tests, script `fakeAi.reply({ text: 'ok', cache: { read: 800 } })` to report a cache.

## Let the model call your actions

Give `ask` some of your actions as tools, and the model can use them. Passing an action is how you allow it: the model gets those actions and no others.

```kay
--- server
import { s } from 'kay'
import { ask } from '@kaynooo/kayjs-ai'

export const addNote = action(s.Object({ title: s.String({ minLength: 3, maxLength: 100 }) }), ({ title }) => saveNote(title), { tool: 'Adds a note to the visitor\'s list' })

export const assistant = action(s.Object({ messages: s.Array(s.Object({ role: s.UnionEnum(['user', 'assistant']), content: s.String({ maxLength: 4000 }) }), { minItems: 1, maxItems: 40 }) }), ({ messages }) => ask(messages, { tools: [addNote], maxSteps: 4 }).progress())
---
p Assistant
```

The model reads each action's name, its `tool` description and its schema. When it calls one, kay runs it as the visitor who asked. The action keeps its guards, its validation and its rate limits, so a guarded action is refused for an anonymous visitor, as it is on a form.

A call that goes wrong is not an exception. The model is told what failed, such as a field the schema refused or an unknown tool name, and can try again. What an action threw is never shown to it.

`ask` then runs a loop: it calls the model, runs its tools, hands back the results and asks again, until the model answers in plain text. `maxSteps` caps the requests it makes, 5 by default. If the model still wants tools on the last one, the reply ends with `finish` set to `steps`.

A model can be talked into things by the text it reads, a visitor's message say. Offer only actions whose worst call you can accept from that visitor, and keep destructive ones out of `tools`.

The visitor leaving stops the loop. A tool already running finishes, but nothing more is called.

`ask` with tools must run while kay answers a request, in a page, an action or a handler, because the tools run as that visitor. A background job has none.

To show the calls in a chat, return `reply.progress()` from the chat's action instead of the reply: `ask(messages, { tools: [addNote] }).progress()`.

The chat then lists each call before the text of its turn, with its status and, when opened, its arguments and result. Set `toolDetails={false}` on `Chat` to show names and statuses only.

You can also read `reply.progress()` yourself. It gives the text so far and every tool call, again with each change. Each call is `{ id, name, input, status, result }`, its status `running`, then `done` or `failed`. `await reply.calls` gives the final list.

<ReadMore href="/llms/kayjs-ai-tools">What the model is told for each kind of failure, the limits, and how to test it.</ReadMore>

## Limit what visitors spend

A public chat lets anyone run up your bill. Set a limit and a token budget in `kay.config.ts`.

```ts
import { ai } from '@kaynooo/kayjs-ai'
import { sqliteRates } from 'kay/server'

export default defineConfig({
  extensions: [ai({
    limit: { max: 10, window: '1m' },
    budget: { tokens: 50_000, total: 2_000_000, window: '1d', store: sqliteRates('data/ai.sqlite') },
  })],
})
```

`limit` caps how many questions one visitor asks in a window. `budget.tokens` caps the tokens the answers to one visitor may use, and `budget.total` the tokens used for everyone. `ask` reads these on its own, so nothing changes where you call it.

A visitor is counted by address, or by user when kayjs-auth is in `extensions`: a signed-in user has their own quota wherever they connect from, with nothing to add. Behind a reverse proxy, set kay's `proxy` option, or every visitor shares the proxy's address and one quota.

To count users from a session of your own instead, pass `visitor`, a function from the request to the user's id; it wins over kayjs-auth. Never take it from a header or cookie the visitor can set, or they get a fresh budget on every request. A free signup gives each account its own budget, which only `total` caps. In a job with no request, name the visitor with `ask(prompt, { visitor })`, or leave it out: only `total` counts then.

The budget counts tokens, not money, because prices change too often to ship a table. Pick `tokens` from the price of your model. Tokens the provider read from its prompt cache, or wrote to it, count like any other, so a cached chat cannot spend past its budget unseen, even though a cache read costs less.

The count lives in memory and starts over with the server. Give `store` a `sqliteRates(path)` to keep it across restarts and share it between processes. A budget store must be able to `peek`, as both of kay's stores can.

Tokens are added when a reply ends, with the count the provider reports. A reply that goes over the budget while it streams is let finish, and all of it counts. The next question is refused.

While a reply runs, it holds its worst case against the budget: its input plus `maxTokens`. So questions started at the same moment cannot all slip through. A visitor close to the budget cannot start a second reply until the first ends. Other servers sharing a `store` do not see these holds.

Over a limit, the reply fails with an `AiError` of kind `limited`, when you `await` it or first read it. It has `retryAfter`, the seconds until the window closes, and `limit`, which says whether it was `asks`, `budget` or `total`. Nothing is sent to the provider. An action that lets it out answers 429 with a `Retry-After` header, as its own `rateLimit` would, and the chat shows `Too many questions; try again in 12 s`. Set `messages.rateLimit` on the action to word it yourself.

If the store fails or takes more than five seconds when the limit is read, the question is refused with kind `unavailable`, so a broken store never leaves the chat unlimited. If it fails when the tokens are added, the answer still goes out and the failure is logged.

<ReadMore href="/llms/kayjs-ai-limits">Every option, when tokens count, and what a failing store does.</ReadMore>

## Translate what is missing

`kay i18n translate fr` asks the model for every message and entry that French lacks, and saves the answers as drafts. It needs `ai()` in `extensions`, and a provider set up as for `ask`.

```sh
kay i18n translate fr --dry-run
kay i18n translate fr
```

The dry run lists what would be translated, down to the fields of each entry, and guesses the tokens it would cost. It sends nothing and writes nothing.

A translation is kept only when it keeps what the original had. Every `{placeholder}` stays, with the same name. Plural messages get the forms the language needs, such as `few` and `many` in Russian. Tags such as `<b>` stay.

In a tag only the text of `title`, `alt`, `aria-label` and `placeholder` is translated, and `href`, `src` and every other attribute stay as they were. A text, original or reply, holding a tag the check cannot read (an odd quote in it) is never written, and an original holding one fails at once, without asking the model.

The tags and comments of a reply must come in the order of the original. A line break the original did not have is refused. A reply that does not pass is asked for once more, then dropped and reported. Nothing wrong is ever written.

Messages are saved with a `// draft` comment, so `kay check` warns until you read them and run `kay i18n accept fr`. An entry of a localized collection is saved in the `fr` folder, and never over an entry that is already there.

Every plain text field of an entry is translated. Wrap one that holds a brand, a category or a code in `untranslated`, from `kay/content`, and it keeps the original's value:

```ts
brand: untranslated(t.String())
```

If the collection has `draft: 'field'`, that field is set to true, so the entry stays hidden in production until you publish it. Otherwise the entry starts with a `# draft` line in its header, which you delete once you have read it. Saving the entry from a CMS removes it too. Such an entry is shown at once, so read it before you deploy. `kay check` warns about it until the line is gone.

A long body is translated in parts, cut between paragraphs and never inside a code block, and the entry is saved only when every part passed.

A run that stops half way leaves whole files. Run it again to translate what is left.

<ReadMore href="/llms/kayjs-ai-translating">The checks on a reply, which fields of an entry are translated, and how each kind of entry is marked.</ReadMore>

## Errors

A failure throws an `AiError` with a `kind`: `auth`, `rate-limited`, `unavailable`, `invalid`, `network`, `timeout`, `cut`, `protocol` or `limited`. A rate limit has `retryAfter` in seconds. A reply cut halfway has `partial`, the text that came. Nothing is retried for you.

## Test it

Under `bun test`, `ask` always answers from `fakeAi`, even when a key is set. A test says what the model answers and reads what was asked.

```ts
import { ask, fakeAi } from '@kaynooo/kayjs-ai'

fakeAi.reply(['It ', 'works'])

expect(await ask('Hi')).toBe('It works')
expect(fakeAi.last()?.messages).toEqual([{ role: 'user', content: 'Hi' }])
```

`fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })` makes the model call a tool, and the next script answers once the results are back. `fakeAi.fail(error)` makes the next ask fail, and `fakeAi.clear()` forgets everything. With nothing scripted, the fake answers `Fake reply to:` followed by your last message. In development the fake answers too, until a provider is configured.

<ReadMore href="/llms/kayjs-ai-testing-and-errors">Scripting the fake, every error kind, and building a provider by hand.</ReadMore>

## An example

The chat on these docs is built with it: [Ask the docs](/guides/ask-the-docs) says what it reads, and its source is a layout with one `ChatLauncher`.

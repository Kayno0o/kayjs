# Chat island

## Common tasks

### Use

```kay
--- server
import { ask } from '@kaynooo/kayjs-ai'
import { s } from 'kay'

export const reply = action(s.Object({ messages: s.Array(s.Object({ role: s.UnionEnum(['user', 'assistant']), content: s.String({ maxLength: 4000 }) }), { minItems: 1, maxItems: 40 }) }), ({ messages }) => ask(messages, { system: 'Be brief' }))
---
```

```kay
---
import Chat from '@kaynooo/kayjs-ai/chat.kay'
import { reply } from '../routes/reply.kay'
---
Chat(action={reply} label="Assistant")
```

### Attaching files

`attach` lets the visitor send images and PDFs the model reads ([Images and PDFs](attachments.md)). The action's schema takes them as `attachments` on a message, and `ask(messages)` shows them to the model with nothing else to wire:

```kay
--- server
import { ask } from '@kaynooo/kayjs-ai'
import { s } from 'kay'

const file = s.File({ type: 'image/png' })

export const reply = action(s.Object({ messages: s.Array(s.Object({ role: s.UnionEnum(['user', 'assistant']), content: s.String({ maxLength: 4000 }), attachments: s.Optional(s.Array(file, { maxItems: 4 })) }), { minItems: 1, maxItems: 40 }) }), ({ messages }) => ask(messages), { maxSize: '20mb' })
---
```

```kay
Chat(action={reply} attach)
```

- A button beside the field (its `attach` part, a plus, named `attachLabel`), dropping on it and pasting a file anywhere on the page outside a text field attach files, which show as chips with a remove button above the field and then in the visitor's turn. A message may hold files alone.
- `accept` (images and PDFs), `maxFiles` (4 a message) and `maxFileSize` (5 MB each, in bytes) are the upload's checks, made before anything is sent; a file left out says why in a notice: `attachRefusedLabel`, `attachTooBigLabel` or `attachFullLabel`. Words: `ai.chat.attach`, `remove`, `attachRefused`, `attachTooBig` and `attachFull`; `@attachIcon` replaces the plus.
- The action still checks: `s.File({ type })` reads the bytes of a top-level field only, so for a file nested in `messages` `ask` reads them again and answers 415 for a file that is no image or PDF (`unsupported`), 413 past its `maxAttachmentBytes`. Take `maxSize` for `maxFiles` files of `maxFileSize` on the action.
- The files ride on the history: each send posts those of the `keep` latest messages again, so the model sees them in a follow-up, and a 413 shrinks the history counting each file as `ask` prices an image. The files live in the page: `remember` keeps the text of a turn, so after a reload the model no longer sees them.
- Stop's call to the server posts the last message without its files.

### Regenerating and editing

`regenerate` adds a button under the last reply that asks again for it, and `editable` one on each message of the visitor that turns it into a field to change and send again. Both are off by default.

```kay
Chat(action={reply} regenerate editable)
```

- A regenerated reply leaves the log and the history, reasoning, tool calls and code with it, and the history is posted again ending on the message before it. An edited message and every turn after it leave, and the history is posted ending on the new message. A message keeps the files it had while the page holds them; a restored one has none. Enter saves an edit, Escape cancels it.
- Regenerate is not offered for a reply that waits for the visitor's allowance, nor after an answer to a held tool call, whose approval is spent, and edit is not offered on such an answer. Nothing is offered while a reply is under way; a kept reply that resumes after a reload ends before the buttons come. A regenerate or an edit stopped, or refused (422), before the first word puts the history back as it was, the edited text returning to the field.
- A server that keeps the conversation tells these posts from a fresh send with `replaces()` (`@kaynooo/kayjs-ai`), read from the `x-kai-replaces` header, which no schema has to take: `{ kind: 'regenerate' | 'edit', turns }`, or `undefined` for a fresh send. `turns` counts the trailing turns the chat showed that the post supersedes, its last message included (a regenerate is `2`: the reply and the message posted again; an edit of the third of five turns is `3`). One rule serves both: drop that many stored turns, append the last posted message, answer. The count is of the turns the chat shows, so a server that stores less (a reply that only called tools has no text to post, and a reload with `remember` restores text turns only) clamps it to what it holds; the value comes from the browser. It assumes the server stored the message a Try again or an edit of the last message answers. A chat that is posted the whole history needs nothing.

```ts
export const reply = action(schema, async ({ messages }) => {
  const dropped = replaces()?.turns ?? 0

  await conversation.dropLast(dropped)
  await conversation.add(messages.at(-1)!)

  return ask(await conversation.messages())
})
```

- Try again after a failed regenerate or edit posts the same request with the same header, as a fresh send's retry posts its message again; a Stop before the first word puts the history back and forgets it. A resume after a reload carries none, the server having dropped the turns by then.
- An edit stays open through a message sent from outside, an Allow or Deny and the reply to it, its Save disabled while a reply is under way. Cancel, Escape (in the field or on Save or Cancel, which neither stops a reply nor closes a `ChatLauncher` panel) and Save close it: Cancel and Escape put the focus back on the message's edit button, which is named `Edit the message: <first words>`; Save focuses the field, as the reply is under way. A Save with no text and no file says `ai.chat.editEmpty` (`Write a message to send.`, `editEmptyLabel`).
- Words: `ai.chat.regenerate` (`Regenerate the reply`), `edit` (`Edit the message`), `save` (`Save and send`) and `cancel`, props `regenerateLabel`, `editLabel`, `saveLabel` and `cancelLabel`; `@regenerateIcon` and `@editIcon` replace the circular arrow and the pencil (kayjs-ui's `refresh` and `edit` slots); `ChatLauncher` takes them too.

### Floating chat

`ChatLauncher` puts the chat behind a button on every page: [Floating chat](chat-launcher.md).

## Reference

### Rules that are easy to get wrong

- `Chat` is an island, and a page or layout with a `--- server` fence passes it the action straight: `Chat(action={reply})` needs no wrapper component. The action crosses as its URL, so it is an export of a route module, declared in the page or imported from another route.
- The action returns the reply from a plain arrow, `({ messages }) => ask(messages)`, or `ask(messages).stream()` after an `await`: `kay check` reports an `async` handler returning the reply itself (`async-reply`), which would show the whole text at once.
- The action's schema must accept `{ messages: { role: 'user' | 'assistant', content: string }[] }` and nothing the chat does not send. It is posted the whole history on every send, so bound `content` and `maxItems` in the schema, with `maxItems` at least `keep` (20), and `rateLimit` on the action. A message the schema refuses (422) leaves the history and returns to the field, on a retry as on a fresh send, ahead of anything typed since. The action may return `ctx.fail(...)` besides the reply; a string it passes shows as the alert's message, below status 500.
- The chat is built on kayjs-ui, an optional peer of kayjs-ai that only `Chat` and `ChatLauncher` need (`kay add ui` installs it with Tailwind and the icon set; an app using `ask()` alone installs none of them): its failure alert is a `Notice`, Try again a `Button`, and its field and icons read kayjs-ui's `kui-` classes and theme tokens, so the app imports kayjs-ui's `theme.css` and has an icon set, as for any kayjs-ui component. The icons are kayjs-ui's slots `chat`, `close`, `plus`, `expand`, `collapse`, `send` and `stop`, so an app's `settings.icons` restyles them like the rest, and the `@icon`-style blocks still override one.
- The markdown renderer loads with the first message to draw, not with the island: a restored history or a first reply shows as written for an instant, then formatted. A reply is markdown through `markdownHtml` then `sanitizeHtml` again, which drops images and task checkboxes: a model reading a hostile page could point an image at a URL carrying the conversation. Tables, links (`rel="nofollow ugc noopener"`, `target="_blank"` by default: the conversation lives in the page, so a link opens in a new tab and a page swap never drops it; see `links`), code and lists stay. A reply carries `kui-prose`.
- A tool that changes something is held until the visitor allows it ([Actions as tools](tools.md#allowing-a-write)): the turn shows Allow and Deny under its calls, and the visitor's answer is their next message. The row shows the tool and its arguments whatever `toolDetails` says. Words: `approvalLabel` (`Needs your approval`), `allowLabel`, `denyLabel`, `allowedLabel` (`Allowed:`, then the tool and its arguments) and `deniedLabel`, the `ai.chat.approval`, `allow`, `deny`, `allowed` and `denied` keys. The buttons are the parts `approval`, `approvalText`, `allow` and `deny`.
- To show the tool calls of `ask(messages, { tools })`, the action returns `.progress()` instead: `({ messages }) => ask(messages, { tools: [addNote] }).progress()`. The stream then carries `{ text, calls }` and the chat shows the calls before the text, in the reply being written and in the finished turn. An action returning the reply itself shows text only.
- Code in a reply is highlighted by the app's own highlighter, the `markdown.highlight` of `kay.config.ts` its Markdown content uses, on the server: once a block's closing fence has streamed, `.progress()` adds the block to the snapshot as `code: { markup, html }[]` (only the blocks closed since the previous snapshot) and the chat swaps the plain block for `html`. No highlighter reaches the browser, a block still streaming or a fence left open stays plain, and an app without `markdown.highlight` shows plain code as before. A highlighter that throws leaves its block plain. The `html` is sanitized on the server as a reply is, so a hostile block cannot inject markup: the tags kept are those of a reply plus `div` and `span`, with `class`, `tabindex` and `data-search` on `div`, `span`, `pre` and `code` as listed there, a `style` keeping only declarations of colour, font style or weight, text decoration and custom properties (`--shiki-light`) with no URL, and a copy `button` of the frame is dropped. The language of a fence is given to the highlighter only when it is a plain word. It needs `.progress()` (a plain `ask(messages)` streams text only), and the highlighted blocks are not kept by `remember`, so a reloaded conversation shows plain code.

### Props

- `action`: the streaming action, typed `Action<{ messages: ChatMessage[] }, AsyncIterable<string | Progress> | Failure<unknown>>`, so `kay check` refuses one whose schema wants more or whose handler answers anything but a stream.
- `keep`: how many of the latest messages each send posts (20), so a long chat stays under the schema's `maxItems`. The history posted opens on a user message, so an assistant one at its start, such as a greeting in `initial`, is left out; turns with neither text nor files are not counted.
- `maxChars`: the most characters each send posts (40,000), the oldest messages leaving first and the last staying; the chat lowers it by itself: a 413 from the action (`ask`'s `too-long` past its `maxInputChars`) makes it post half as much, oldest messages first, and ask again (5 times at most) until the action takes it or only the last message is left, remembering the size for the next sends. Each refusal counts against the action's rate limit, so set `maxChars` to the action's `maxInputChars` to avoid the first one.
- `initial`: `Message[]` shown to start with and sent with the first message.
- `label`: names the message list and the field for screen readers (`Chat`).
- `disclosure` (`You are talking to an AI. Your messages are sent to its provider to answer.`, the `ai.chat.disclosure` message): the line under the log, `p.kai-chat-disclosure`; `''` hides it, [personal data](personal-data.md).
- `greeting` (`How can I help?`) and `suggestions` (`string[]`): the empty chat shows them in `.kai-chat-empty` instead of the log, and a click on a suggestion sends it. `toolLabels` (`Record<string, string>`): the phrase for a tool by name in the folded line of a reply's tools, `{ search_docs: 'Searched the docs' }`; a tool without one shows its name, one called more than once adds `x2`. `@sendIcon`, `@stopIcon`: blocks for the round buttons, in place of an arrow and a square.
- Texts are looked up under `ai.chat.<name>` keys (`ai.chat.send`, `ai.chat.greeting`, `ai.chat.open`, `ai.chat.running`: `<name>` is the prop without its `Label` suffix, `ai.chat.error` for `errorMessage`, `ai.chat.new` for `newLabel`) in the app's catalogs, then the English; kayjs-ai ships the French, so a `fr` page needs no setup. A prop replaces the message. The props: `placeholder`, `sendLabel`, `stopLabel`, `retryLabel`, `thinkingLabel` (read out while the first words are awaited), `stoppedLabel` (marks a reply cut by Stop), `tableLabel` (names a table of a reply, `Table`; a reply with several numbers them `Table 1`, `Table 2`), `errorMessage`.
- `reasoning` (true): shows what the model thought, when the action returns `.progress()` and the provider streams it, folded above the turn's text in `details.kai-chat-reasoning` (`summary` named by `reasoningLabel`, `Reasoning`, `ai.chat.reasoning`; the text in `p.kai-chat-reasoning-text`, shown as plain text). `reasoning={false}` hides it. The thinking is not kept by `remember`, as the tool calls are not.
- `toolDetails` (true): each tool call opens to its arguments and result, as plain text. `false` shows the name and status only. `runningLabel`, `doneLabel`, `failedLabel`, `argumentsLabel` and `resultLabel` word the status and the two parts (`Running`, `Done`, `Failed`, `Arguments`, `Result`). The name is the tool's, such as `add_note`.
- `newButton`: shows a start-over button before the field once the log holds a turn (`newLabel`, `New conversation`, named by `ai.chat.new`; `@newIcon` replaces its plus). It stops a reply under way and clears the log, the field and the kept history. Without it, another control starts over by dispatching `new CustomEvent('kai-chat-new')` on the `.kai-chat` element, which is how `ChatPanel`'s header button does it.
- `fill`: a chat that is a page's main content takes its container's height, which the app gives (a flex column, a grid row, `h-dvh`): the log, or the greeting in the empty chat, takes the space with the greeting at the bottom beside the form, the log scrolls, and the form stays last, as in the launcher's panel (`data-fill` on the section). Without it the log grows with the conversation up to `32rem` and scrolls past it.
- `remember`: a session storage key under which the conversation is kept, so a reload of the tab finds it again (the text of each turn, not its tool calls), and a reply that was under way at the reload with it when the ask has `outlive`; none by default.
- `links`: `apart` (default) opens a link of a reply in a new tab; `here` opens a link to a page of this site in place, for a chat that survives a swap, and still opens another site's apart.
- `variant` (`bubble`, or `plain` for the visitor's message as bare text), `tone` (`accent`, or `neutral` for the text colour in place of the accent on the send button and bubble) and `size` (`sm`, `md`, `lg`, the type of the turns and suggestions), the kayjs-ui vocabulary, written as `data-variant`, `data-tone` and `data-size` on the section.
- `class`: a string for the section, or an object of parts to restyle it, see Restyle.

### Restyle

Its parts - `root`, `empty`, `greeting`, `suggestions`, `suggestion`, `log`, `turn`, `text`, `thinking`, `reasoning`, `reasoningText`, `note`, `status`, `disclosure`, `form`, `field`, `send`, `retry`, `actions`, `regenerate`, `edit`, `editField`, `save` and `cancel` (the Try again button, shown only after a failed reply) - keep their `kai-` classes and take utilities from `src/ui.ts` or a `class` object: `defineUi({ '@kaynooo/kayjs-ai/chat.kay': { parts: { send: 'size-12', turn: 'text-base' } } })`, `Chat(class={{ log: 'max-h-96' }})`. A `class` string restyles the root. The tool calls are `@kaynooo/kayjs-ai/chat-calls.kay` (`root`, `summary`, `list`, `call`, `name`, `status`, `title`, `code`) the sources under a reply `@kaynooo/kayjs-ai/chat-sources.kay` (`root`, `label`, `list`, `item`, `link`) and the launcher's panel `@kaynooo/kayjs-ai/chat-panel.kay` (`root`, `panel`, `head`, `title`, `actions`, `action`, `expand`, `body`, `button`, `glyph`). A table of a reply is built from the reply's markup and keeps `.kai-chat-table`.

### Behaviour

- The history lives in the island; each send posts all of it and the reply streams into a pending turn as markdown, joining the history when the stream ends.
- Enter sends, Shift+Enter breaks the line. While a reply is under way the round Send button (an arrow, named `sendLabel`) becomes Stop (a square, `stopLabel`), and Escape anywhere in the chat stops too, its default prevented so a dialog or panel around it stays open: it aborts the call, or closes the stream, and the words that came stay as a turn marked `stoppedLabel`. A Stop before the first word returns the message to the field, as a refused one, so the next send posts one user turn.
- A refused call or a stream that breaks off shows the refusal's message when the action gave one, else `errorMessage`, in a `kui-notice` alert with a retry button, when no word of the reply came, asking again with the same history, no second copy of the message; what a broken stream had delivered stays.
- The log is `role="log"`; the turn being written is `aria-hidden` and a hidden polite status line says `thinkingLabel` and then each tool call as it starts and ends (`add_note: Running`, `add_note: Done`, in the call labels), one added line each, so a screen reader hears each finished turn and each call once, not word by word. The log scrolls with the reply unless the visitor scrolled up.
- Tool calls: `details.kai-chat-calls` before `.kai-chat-text` in the turn, folded to one muted `summary.kai-chat-calls-summary` (`Searched the docs x2, read_page (Failed)`) and holding `ul.kai-chat-calls-list` with one `li.kai-chat-call[data-status]` per call (`running`, `done`, `failed`) with `.kai-chat-call-name` and `.kai-chat-call-status`, and a `details` holding `pre.kai-chat-call-code` for the arguments and result. A turn that only called tools joins the history without text and is not posted back, since a provider refuses an empty message. Results are what the model was told, shown as is: keep a result you would not show the visitor out of the actions you offer, or set `toolDetails={false}`.
- A table of a reply sits in `.kai-chat-table`, a focusable `group` named by `tableLabel` that scrolls sideways when the table is wider than its bubble; cells keep their words whole.
- Before the first message the log is not displayed: the greeting and suggestions stand in.
- The visitor's message is a tinted bubble at the right, an answer the full width of the log with no frame, and the first token is awaited behind three pulsing dots. Code in answers is `0.75rem`.
- Markup: `.kai-chat` holds `.kai-chat-log` (turns `.kai-chat-turn[data-role]`, the pending one `[data-pending]`, text in `.kai-chat-text`) and `.kai-chat-form`; override them in the app's CSS.

Citations of a reply (`[1]` linked, the cited sources listed under the turn) are in [Chat sources](chat-sources.md).

### A reply that outlives the page

With `ask(messages, { outlive: true })` in the action, a `Chat` given `remember` loses nothing to a reload or a closed tab, with no code in the app.

- Each send carries an `x-kai-reply` header naming the reply, which a Chat with `remember` keeps in session storage beside the conversation until the reply ends. After a reload that finds a message with no answer, the chat asks the action for that reply again (`resume`): the finished turn appears, or the stream picks up from the top and goes on. A second reload mid-reply does the same.
- If the server kept nothing (a restart, the half hour passed, an action without `outlive`), no provider is asked and the message returns to the field.
- Stop, Escape and New conversation end the reply on the server too, by one more call to the action (`stop`) that only a reply which outlives costs: the snapshots of `.progress()` say so (`outlives`), so a plain Chat's Stop makes no extra call. A Stop before the first snapshot sends it anyway, as the reply may outlive, and a text-only `.stream()` reply cannot say so, so use `.progress()` with `outlive`. Closing or reloading the tab does not end the reply. A chat without `remember` cannot resume, but stops the same. The stop call posts the last message only, and a stop reaching the server before its send still ends the reply once that send arrives.
- The resume and stop calls go through the action like a send, so its guards, its own `protect.rateLimit` and any code before `ask` run for them. They ask no provider and cost no tokens or `ai()` limit, and a resume or stop that finds the reply its visitor kept gives back the attempt the action's `protect.rateLimit` counted ([Asking](asking.md#a-reply-that-outlives-the-visitor)).

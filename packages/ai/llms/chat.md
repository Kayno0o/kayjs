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

### Floating chat

`ChatLauncher` (`@kaynooo/kayjs-ai/chat-launcher.kay`) is the chat as a button at the bottom right of every page that opens it in a panel. Put it once in the root layout, a `--- server` fence passing the action as for `Chat`, and it needs no other wiring:

```kay
--- server
import { reply } from './reply.kay'
--- script
import ChatLauncher from '@kaynooo/kayjs-ai/chat-launcher.kay'
---
slot
ChatLauncher(action={reply} label="Ask the docs")
```

## Reference

### Rules that are easy to get wrong

- `Chat` is an island, and a page or layout with a `--- server` fence passes it the action straight: `Chat(action={reply})` needs no wrapper component. The action crosses as its URL, so it is an export of a route module, declared in the page or imported from another route.
- The action returns the reply from a plain arrow, `({ messages }) => ask(messages)`, or `ask(messages).stream()` after an `await`: `kay check` reports an `async` handler returning the reply itself (`async-reply`), which would show the whole text at once.
- The action's schema must accept `{ messages: { role: 'user' | 'assistant', content: string }[] }` and nothing the chat does not send. It is posted the whole history on every send, so bound `content` and `maxItems` in the schema, with `maxItems` at least `keep` (20), and `rateLimit` on the action. A message the schema refuses (422) leaves the history and returns to the field, on a retry as on a fresh send, ahead of anything typed since. The action may return `ctx.fail(...)` besides the reply; a string it passes shows as the alert's message, below status 500.
- The chat is built on kayjs-ui, an optional peer of kayjs-ai that only `Chat` and `ChatLauncher` need (`kay add ui` installs it with Tailwind and the icon set; an app using `ask()` alone installs none of them): its failure alert is a `Notice`, Try again a `Button`, and its field and icons use the `kui-` classes and `--color-kui-*` tokens, so the app imports kayjs-ui's `theme.css` and has an icon set, as for any kayjs-ui component.
- A reply is markdown through `markdownHtml` then `sanitizeHtml` again, which drops images and task checkboxes: a model reading a hostile page could point an image at a URL carrying the conversation. Tables, links (`rel="nofollow ugc noopener"`, `target="_blank"` by default: the conversation lives in the page, so a link opens in a new tab and a page swap never drops it; see `links`), code and lists stay.
- To show the tool calls of `ask(messages, { tools })`, the action returns `.progress()` instead: `({ messages }) => ask(messages, { tools: [addNote] }).progress()`. The stream then carries `{ text, calls }` and the chat shows the calls before the text, in the reply being written and in the finished turn. An action returning the reply itself shows text only.
- Code in a reply is highlighted by the app's own highlighter, the `markdown.highlight` of `kay.config.ts` its Markdown content uses, on the server: once a block's closing fence has streamed, `.progress()` adds the block to the snapshot as `code: { markup, html }[]` (only the blocks closed since the previous snapshot) and the chat swaps the plain block for `html`. No highlighter reaches the browser, a block still streaming or a fence left open stays plain, and an app without `markdown.highlight` shows plain code as before. A highlighter that throws leaves its block plain. The `html` is sanitized on the server as a reply is, so a hostile block cannot inject markup: the tags kept are those of a reply plus `div` and `span`, with `class`, `tabindex` and `data-search` on `div`, `span`, `pre` and `code` as listed there, a `style` keeping only declarations of colour, font style or weight, text decoration and custom properties (`--shiki-light`) with no URL, and a copy `button` of the frame is dropped. The language of a fence is given to the highlighter only when it is a plain word. It needs `.progress()` (a plain `ask(messages)` streams text only), and the highlighted blocks are not kept by `remember`, so a reloaded conversation shows plain code.

### Floating chat behaviour

- It takes `Chat`'s props but `links`, which it sets to `here`, and: `openLabel` (`Open the chat`, the button's name, and its tooltip while the panel is closed) and `closeLabel` (`Close the chat`, the name of the panel's close button and the button's tooltip while it is open), `remember` (the session storage key, none by default), `class` on the wrapper, and blocks `newLabel` (`New conversation`), `expandLabel` (`Enlarge the chat`), `collapseLabel` (`Shrink the chat`), blocks `@icon`, `@closeIcon`, `@newIcon`, `@expandIcon` and `@collapseIcon` for the icons (a chat bubble, a cross, a plus and two arrow pairs by default; any `Icon` or inline `svg`), and `@note` for a line under the chat. `@sendIcon` and `@stopIcon` replace the round send and stop buttons' icons (an arrow and a square). `label` heads the panel.
- The button and panel are one island marked `persist`, so the panel, open or closed, and the conversation stay across page swaps. The chat inside is an island of its own marked `hydrate="visible"` in a hidden panel: its JavaScript loads on the first open, and until then a page carries the button's script only.
- Opening moves the focus to the chat's field, Escape closes the panel and returns the focus to the button (a reply under way stops on the first Escape instead), and the button carries `aria-expanded`, `aria-controls` and a `data-tooltip`, which shows when the app renders kayjs-ui's `TooltipHost`.
- A link of a reply to a page of the site navigates in place, the panel following the reader; a link to another site opens in a new tab.
- The conversation lives in the island, so it stays across page swaps and a reload of the tab starts afresh: nothing is written to storage unless `remember` names a key, as the next visitor to use the tab would read it. With `remember`, a reload finds the conversation again (the tool calls of its replies are not kept); a site with sign-in gives it a key per visitor, such as `` `kai-chat-${user.id}` ``, and the key, not a clearing on sign-out, is what keeps one visitor's conversation from the next.
- Without JavaScript the button does nothing, and the hidden chat's markup is in every page.
- The panel is 36rem wide and a fixed `40rem` tall, or the window's height less 7.5rem when that is less, so it neither grows nor shrinks as the conversation fills or empties: the log fills the space and scrolls, the form stays at the bottom, and the greeting and suggestions sit above it. It fits a phone (`width: min(var(--kai-chat-width, 36rem), calc(100vw - 2rem))`). The header's New conversation button sends a `kai-chat-new` event to the `.kai-chat`, which stops a reply under way and clears the log, the field and the kept history; Enlarge switches to `--kai-chat-width-large` (56rem) and `--kai-chat-height-large` (the window's height less 7.5rem) (`data-large` attribute on the panel; hidden under 40rem). The button is a filled accent circle showing `closeIcon` while open, its tooltip at its left.
- Custom properties on any ancestor restyle it, all optional: `--kai-chat-accent`, `--kai-chat-bubble` (the visitor's message), `--kai-chat-radius`, `--kai-chat-shadow`, `--kai-chat-width`, `--kai-chat-width-large`, `--kai-chat-height`, `--kai-chat-height-large`.

### Props

- `action`: the streaming action, typed `Action<{ messages: Message[] }, AsyncIterable<string | Progress> | Failure<unknown>>`, so `kay check` refuses one whose schema wants more or whose handler answers anything but a stream.
- `keep`: how many of the latest messages each send posts (20), so a long chat stays under the schema's `maxItems`. The history posted opens on a user message, so an assistant one at its start, such as a greeting in `initial`, is left out; turns without text are not counted.
- `maxChars`: the most characters each send posts (40,000), the oldest messages leaving first and the last staying; the chat lowers it by itself: a 413 from the action (`ask`'s `too-long` past its `maxInputChars`) makes it post half as much, oldest messages first, and ask again (5 times at most) until the action takes it or only the last message is left, remembering the size for the next sends. Each refusal counts against the action's rate limit, so set `maxChars` to the action's `maxInputChars` to avoid the first one.
- `initial`: `Message[]` shown to start with and sent with the first message.
- `label`: names the message list and the field for screen readers (`Chat`).
- `disclosure` (`You are talking to an AI. Your messages are sent to its provider to answer.`, the `ai.chat.disclosure` message): the line under the log, `p.kai-chat-disclosure`; `''` hides it, [personal data](personal-data.md).
- `greeting` (`How can I help?`) and `suggestions` (`string[]`): the empty chat shows them in `.kai-chat-empty` instead of the log, and a click on a suggestion sends it. `toolLabels` (`Record<string, string>`): the phrase for a tool by name in the folded line of a reply's tools, `{ search_docs: 'Searched the docs' }`; a tool without one shows its name, one called more than once adds `x2`. `@sendIcon`, `@stopIcon`: blocks for the round buttons, in place of an arrow and a square.
- Texts are looked up under `ai.chat.<name>` keys (`ai.chat.send`, `ai.chat.greeting`, `ai.chat.open`, `ai.chat.running`: `<name>` is the prop without its `Label` suffix, `ai.chat.error` for `errorMessage`, `ai.chat.new` for `newLabel`) in the app's catalogs, then the English; kayjs-ai ships the French, so a `fr` page needs no setup. A prop replaces the message. The props: `placeholder`, `sendLabel`, `stopLabel`, `retryLabel`, `thinkingLabel` (read out while the first words are awaited), `stoppedLabel` (marks a reply cut by Stop), `tableLabel` (names a table of a reply, `Table`; a reply with several numbers them `Table 1`, `Table 2`), `errorMessage`.
- `toolDetails` (true): each tool call opens to its arguments and result, as plain text. `false` shows the name and status only. `runningLabel`, `doneLabel`, `failedLabel`, `argumentsLabel` and `resultLabel` word the status and the two parts (`Running`, `Done`, `Failed`, `Arguments`, `Result`). The name is the tool's, such as `add_note`.
- `remember`: a session storage key under which the conversation is kept, so a reload of the tab finds it again (the text of each turn, not its tool calls); none by default.
- `links`: `apart` (default) opens a link of a reply in a new tab; `here` opens a link to a page of this site in place, for a chat that survives a swap, and still opens another site's apart.
- `variant` (`bubble`, or `plain` for the visitor's message as bare text), `tone` (`accent`, or `neutral` for the text colour in place of the accent on the send button and bubble) and `size` (`sm`, `md`, `lg`, the type of the turns and suggestions), the kayjs-ui vocabulary, written as `data-variant`, `data-tone` and `data-size` on the section.
- `class`: a string for the section, or an object of parts to restyle it, see Restyle.

### Restyle

Its parts - `root`, `empty`, `greeting`, `suggestions`, `suggestion`, `log`, `turn`, `text`, `thinking`, `note`, `status`, `disclosure`, `form`, `field` and `send` - keep their `kai-` classes and take utilities from `src/ui.ts` or a `class` object: `defineUi({ '@kaynooo/kayjs-ai/chat.kay': { parts: { send: 'size-12', turn: 'text-base' } } })`, `Chat(class={{ log: 'max-h-96' }})`. A `class` string restyles the root. The tool calls are `@kaynooo/kayjs-ai/chat-calls.kay` (`root`, `summary`, `list`, `call`, `name`, `status`, `title`, `code`) and the launcher's panel `@kaynooo/kayjs-ai/chat-panel.kay` (`root`, `panel`, `head`, `title`, `actions`, `action`, `expand`, `body`, `button`, `glyph`). A table of a reply is built from the reply's markup and keeps `.kai-chat-table`.

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

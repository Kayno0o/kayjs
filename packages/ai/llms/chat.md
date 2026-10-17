# Chat island

## Rules that are easy to get wrong

- `Chat` is an island, and a page or layout with a `--- server` fence passes it the action straight: `Chat(action={reply})` needs no wrapper component. The action crosses as its URL, so it is an export of a route module, declared in the page or imported from another route.
- The action must return the reply from a plain arrow, `({ messages }) => ask(messages)`. An `async` handler awaits it and the chat then shows the whole text at once, with no streaming.
- The action's schema must accept `{ messages: { role: 'user' | 'assistant', content: string }[] }` and nothing the chat does not send. It is posted the whole history on every send, so bound `content` and `maxItems` in the schema, with `maxItems` at least `keep` (20), and `rateLimit` on the action. A message the schema refuses (422) leaves the history and returns to the field, on a retry as on a fresh send, ahead of anything typed since. The action may return `ctx.fail(...)` besides the reply; a string it passes shows as the alert's message, below status 500.
- The chat styles itself with `kui-` classes and `--color-kui-*` tokens, so the app imports kayjs-ui's `theme.css`. No kayjs-ui component is imported and no icon set is needed.
- A reply is markdown through `markdownHtml` then `sanitizeHtml` again, which drops images and task checkboxes: a model reading a hostile page could point an image at a URL carrying the conversation. Tables, links (`rel="nofollow ugc"`), code and lists stay.
- To show the tool calls of `ask(messages, { tools })`, the action returns `.progress()` instead: `({ messages }) => ask(messages, { tools: [addNote] }).progress()`. The stream then carries `{ text, calls }` and the chat shows the calls before the text, in the reply being written and in the finished turn. An action returning the reply itself shows text only.

## Use

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

## Props

- `action`: the streaming action, typed `Action<{ messages: Message[] }, AsyncIterable<string | Progress> | Failure<unknown>>`, so `kay check` refuses one whose schema wants more or whose handler answers anything but a stream.
- `keep`: how many of the latest messages each send posts (20), so a long chat stays under the schema's `maxItems`. The history posted opens on a user message, so an assistant one at its start, such as a greeting in `initial`, is left out; turns without text are not counted.
- `initial`: `Message[]` shown to start with and sent with the first message.
- `label`: names the message list and the field for screen readers (`Chat`).
- Texts, in English by default: `placeholder`, `sendLabel`, `stopLabel`, `retryLabel`, `thinkingLabel` (read out while the first words are awaited), `stoppedLabel` (marks a reply cut by Stop), `tableLabel` (names a table of a reply, `Table`; a reply with several numbers them `Table 1`, `Table 2`), `errorMessage`.
- `toolDetails` (true): each tool call opens to its arguments and result, as plain text. `false` shows the name and status only. `runningLabel`, `doneLabel`, `failedLabel`, `argumentsLabel` and `resultLabel` word the status and the two parts (`Running`, `Done`, `Failed`, `Arguments`, `Result`). The name is the tool's, such as `add_note`.
- `class` on the section.

## Behaviour

- The history lives in the island; each send posts all of it and the reply streams into a pending turn as markdown, joining the history when the stream ends.
- Enter sends, Shift+Enter breaks the line. While a reply is under way Send becomes Stop, and Escape in the field stops too: it aborts the call, or closes the stream, and the words that came stay as a turn marked `stoppedLabel`. A Stop before the first word returns the message to the field, as a refused one, so the next send posts one user turn.
- A refused call or a stream that breaks off shows the refusal's message when the action gave one, else `errorMessage`, in a `kui-notice` alert with a retry button, when no word of the reply came, asking again with the same history, no second copy of the message; what a broken stream had delivered stays.
- The log is `role="log"`; the turn being written is `aria-hidden` and a hidden status line says `thinkingLabel`, so a screen reader hears each finished turn once, not word by word. The log scrolls with the reply unless the visitor scrolled up.
- Tool calls: `ul.kai-chat-calls` before `.kai-chat-text` in the turn, one `li.kai-chat-call[data-status]` per call (`running`, `done`, `failed`) with `.kai-chat-call-name` and `.kai-chat-call-status`, and a `details` holding `pre.kai-chat-call-code` for the arguments and result. A turn that only called tools joins the history without text and is not posted back, since a provider refuses an empty message. Results are what the model was told, shown as is: keep a result you would not show the visitor out of the actions you offer, or set `toolDetails={false}`.
- A table of a reply sits in `.kai-chat-table`, a focusable `group` named by `tableLabel` that scrolls sideways when the table is wider than its bubble; cells keep their words whole.
- Markup: `.kai-chat` holds `.kai-chat-log` (turns `.kai-chat-turn[data-role]`, the pending one `[data-pending]`, text in `.kai-chat-text`) and `.kai-chat-form`; override them in the app's CSS.

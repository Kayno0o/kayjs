# Chat island

## Rules that are easy to get wrong

- `Chat` is an island, and an island cannot take a function from a page: a page, or a layout, with a `--- server` fence cannot pass the action to it. Render `Chat` from a component of the app's own that imports the action from the route declaring it, and use that component in the page; it becomes the island and `Chat` is part of it.
- The action must return the reply from a plain arrow, `({ messages }) => ask(messages)`. An `async` handler awaits it and the chat then shows the whole text at once, with no streaming.
- The action's schema must accept `{ messages: { role: 'user' | 'assistant', content: string }[] }` and nothing the chat does not send. It is posted the whole history on every send, so bound `content` and `maxItems` in the schema: that is the cost cap, with `rateLimit` on the action.
- The chat styles itself with `kui-` classes and `--color-kui-*` tokens, so the app imports kayjs-ui's `theme.css`. No kayjs-ui component is imported and no icon set is needed.
- A reply is markdown through `markdownHtml` then `sanitizeHtml` again, which drops images and task checkboxes: a model reading a hostile page could point an image at a URL carrying the conversation. Tables, links (`rel="nofollow ugc"`), code and lists stay.
- Tool calls and results (#861) have a marked place in the turn's markup, before its text; nothing renders there yet.

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
import { reply } from '../routes/assistant.kay'
---
Chat(action={reply} label="Assistant")
```

## Props

- `action`: the streaming action, typed `Action<{ messages: Message[] }, AsyncIterable<string>>`, so `kay check` refuses one whose schema wants more or whose handler answers anything but a stream.
- `initial`: `Message[]` shown to start with and sent with the first message.
- `label`: names the chat, its message list and its field for screen readers (`Chat`).
- Texts, in English by default: `placeholder`, `sendLabel`, `stopLabel`, `retryLabel`, `thinkingLabel` (read out while the first words are awaited), `stoppedLabel` (marks a reply cut by Stop), `errorMessage`.
- `class` on the section.

## Behaviour

- The history lives in the island; each send posts all of it and the reply streams into a pending turn as markdown, joining the history when the stream ends.
- Enter sends, Shift+Enter breaks the line. While a reply is under way Send becomes Stop, and Escape in the field stops too: it aborts the call, or closes the stream, and the words that came stay as a turn marked `stoppedLabel`.
- A refused call or a stream that breaks off shows `errorMessage` in a `kui-notice` alert with a retry button asking again with the same history, no second copy of the message; what a broken stream had delivered stays.
- The log is `role="log"`; the turn being written is `aria-hidden` and a hidden status line says `thinkingLabel`, so a screen reader hears each finished turn once, not word by word. The log scrolls with the reply unless the visitor scrolled up.
- Markup: `.kai-chat` holds `.kai-chat-log` (turns `.kai-chat-turn[data-role]`, the pending one `[data-pending]`, text in `.kai-chat-text`) and `.kai-chat-form`; override them in the app's CSS.

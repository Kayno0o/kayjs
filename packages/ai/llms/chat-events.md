# Chat events and control

## Common tasks

### Hear what the chat does

`Chat` and `ChatLauncher` take callbacks, so analytics, a badge or a save of the finished turn needs no wrapper around the action. They hold functions, so write them in a component of your own, which renders as an island.

```kay
---
// kay-island
import { reply } from '../routes/chat.kay'
import Chat from '@kaynooo/kayjs-ai/chat.kay'
---
Chat(action={reply} label="Assistant" onSend={({ messages }) => track('ask', messages.length)} onReply={turn => save(turn.content)} onError={failure => report(failure.status)})
```

### Open the launcher from the page

`ChatLauncher` takes `open` and `onOpenChange`, as kayjs-ui's Popover does: the panel follows `open` when the app sets it, and works on its own when `open` is left out.

```kay
---
import { reply } from '../routes/chat.kay'
import ChatLauncher from '@kaynooo/kayjs-ai/chat-launcher.kay'

const open = signal(false)
---
button(type="button" onClick={() => { open = true }}) Ask the assistant
ChatLauncher(action={reply} open={open()} onOpenChange={value => { open = value }})
```

### Start a question from outside

Two events with the text as `detail`: `kai-chat-send` sends it as the next message (as a voice transcript is), and `kai-chat-draft` puts it in front of what the visitor typed and moves the cursor into the field, to read and send. Both ignore blank text, and `kai-chat-send` is ignored while a reply is under way. Dispatch them on `window` when the page has a `ChatLauncher`: it opens the panel first, waits for the chat inside to load, then hands the text over. A `Chat` of its own hears them on its `.kai-chat` element.

```ts
window.dispatchEvent(new CustomEvent('kai-chat-draft', { detail: 'Tell me about this page' }))
```

### Open the launcher from a link

The launcher opens whenever the address fragment is its `hash` (`#chat` by default, written with the `#`), on load and on every change to it, and on a click on any link to that fragment (a second click, or a link to another page), so `a(href="#chat")` needs no script; `hash={false}` turns it off. A `kai-chat-open` event on `window` opens it too. All of these count as the visitor opening it: `onOpenChange(true)` is called, unless the panel was open already.

```ts
window.dispatchEvent(new CustomEvent('kai-chat-open'))
```

### Suggestions per page or visitor

`suggestions` also takes a function returning the list or a promise of it, called once when the chat is drawn (on the server too, so a slow one costs each page view): a list returned at once is drawn by the server, a promise fills in once the chat is hydrated, and one that rejects shows none (the error is logged).

```kay
Chat(action={reply} suggestions={async () => fetchSuggestions(page)})
```

## Reference

### Callbacks

Each is called once per transition, with a throw or a rejected promise logged and the chat left alone. The order for one send:

1. `onSuggestion(text)` when a suggestion is pressed, `onRegenerate()` when Regenerate is, `onEdit(text)` when an edit is saved (the new text).
2. `onSend({ messages })` with the messages posted. Try again calls it again; a reply asked for again after a reload does not.
3. `onToolCall(call)` each time a tool call starts and each time it ends (`reply.progress()` actions), with the `AiToolCall`.
4. One of `onReply(turn)` with the finished `ChatTurnView`, `onStop()` as the visitor presses Stop (called then, whatever has arrived), or `onError({ message, status })` for a refused call (its HTTP status) or a stream that broke off (no status), `message` being what the chat shows.

A reply that ends because the chat left its conversation (a new conversation, another one loaded) calls none of the last. `ChatLauncher` takes them all, and `suggestions`, and passes them on.

### The launcher's `open`

- `open` is read live: set it to `true` to open the panel and `false` to close it. A panel set open on the server is drawn open.
- `onOpenChange(open)` is called when the visitor opens it (button) or closes it (button, close button, Escape), not when the app sets `open`, so the app's state needs no guard against an echo.
- Keep `open` in sync through `onOpenChange`: the panel only follows `open` when it changes, so an app ignoring `onOpenChange` after the visitor closed it must set `false` then `true` to open it again. A throw in `onOpenChange` is logged.
- The focus moves to the field on the visitor's opening, and back to the button on their closing. An app setting `open` leaves the focus where it is.

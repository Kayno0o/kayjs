# Floating chat

## Common tasks

### Use

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

### Behaviour

- It takes `Chat`'s props but `links`, which it sets to `here`, and: `openLabel` (`Open the chat`, the button's name, and its tooltip while the panel is closed) and `closeLabel` (`Close the chat`, the name of the panel's close button and the button's tooltip while it is open), `remember` (the session storage key, none by default), `class` on the wrapper, and blocks `newLabel` (`New conversation`), `expandLabel` (`Enlarge the chat`), `collapseLabel` (`Shrink the chat`), blocks `@icon`, `@closeIcon`, `@newIcon`, `@expandIcon` and `@collapseIcon` for the icons (a chat bubble, a cross, a plus and two arrow pairs by default; any `Icon` or inline `svg`), and `@note` for a line under the chat. `@sendIcon` and `@stopIcon` replace the round send and stop buttons' icons (an arrow and a square). `label` heads the panel.
- The button and panel are one island marked `persist`, so the panel, open or closed, and the conversation stay across page swaps. The chat inside is an island of its own marked `hydrate="visible"` in a hidden panel: its JavaScript loads on the first open, and until then a page carries the button's script only.
- Opening moves the focus to the chat's field, Escape closes the panel and returns the focus to the button (a reply under way stops on the first Escape instead), and the button carries `aria-expanded`, `aria-controls` and a `data-tooltip`, which shows when the app renders kayjs-ui's `TooltipHost`.
- A link of a reply to a page of the site navigates in place, the panel following the reader; a link to another site opens in a new tab.
- The conversation lives in the island, so it stays across page swaps and a reload of the tab starts afresh: nothing is written to storage unless `remember` names a key, as the next visitor to use the tab would read it. With `remember`, a reload finds the conversation again (the tool calls of its replies are not kept), and [a reply under way at the reload](chat.md#a-reply-that-outlives-the-page) too when the app's ask has `outlive`; a site with sign-in gives it a key per visitor, such as `` `kai-chat-${user.id}` ``, and the key, not a clearing on sign-out, is what keeps one visitor's conversation from the next.
- Without JavaScript the button does nothing, and the hidden chat's markup is in every page.
- The panel is 36rem wide and a fixed `40rem` tall, or the window's height less 7.5rem when that is less, so it neither grows nor shrinks as the conversation fills or empties: the log fills the space and scrolls, the form stays at the bottom, and the greeting and suggestions sit above it. It fits a phone (`width: min(var(--kai-chat-width, 36rem), calc(100vw - 2rem))`). The header's New conversation button sends a `kai-chat-new` event to the `.kai-chat`, which stops a reply under way and clears the log, the field and the kept history; a `kai-chat-send` event with the text as its `detail` (`chat.dispatchEvent(new CustomEvent('kai-chat-send', { detail: transcript }))`) sends it as the next message from outside the field, such as a voice transcript, leaving the draft as a suggestion does, and is ignored while a reply is under way or for blank text; Enlarge switches to `--kai-chat-width-large` (56rem) and `--kai-chat-height-large` (the window's height less 7.5rem) (`data-large` attribute on the panel; hidden under 40rem). The button is a filled accent circle showing `closeIcon` while open, its tooltip at its left.
- Custom properties on any ancestor restyle it, all optional: `--kai-chat-accent`, `--kai-chat-bubble` (the visitor's message), `--kai-chat-radius`, `--kai-chat-shadow`, `--kai-chat-width`, `--kai-chat-width-large`, `--kai-chat-height`, `--kai-chat-height-large`.

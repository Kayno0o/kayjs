# kayjs-ai: Conversations kept on the server

## Common tasks

### Keeping a conversation on the server

`keepOnServer` has the server keep the conversation: each send posts the new message alone, `ask` adds the turns it stored before it, and a reload, a link or Back shows the conversation again. The action is the same plain one, nothing in it changes:

```kay
--- server
import { ask, chatMessages } from '@kaynooo/kayjs-ai'
import { s } from 'kay'

export const reply = action(s.Object({ messages: chatMessages() }), ({ messages }) => ask(messages))
--- script
import Chat from '@kaynooo/kayjs-ai/chat.kay'
---
Chat(action={reply} keepOnServer)
```

- The conversation is the visitor's the server names: the ask's `key`, else `ai({ key })`'s, else the signed-in user kayjs-auth (or another library) names to kay, never an id the browser sends, and it is kept under the action's path, so two chats of one visitor keep apart. The browser only says which of the visitor's conversations it shows. A visitor no one names, a guest, keeps their history in the page as without `keepOnServer`. A session that lapses while a conversation is shown is refused its next send (409) before the model is asked; the chat keeps the conversation it shows, says `signedOutLabel`, and posts it whole from then on.
- The page's `conversation` query param names the conversation shown, written by the first send and read when the page loads, so the address can be bookmarked; it is only one of the visitor's own, so a link shared to someone else opens an empty chat for them.
- Regenerate and edit work as they do without it: the server drops the turns `replaces()` counts and stores the new exchange. A reply stopped or broken off part way is kept marked stopped; one stopped or failed before its first word keeps nothing, and the chat puts the message back in the field. Only the last message a send posts is taken, so a client cannot write earlier turns into the conversation.
- The model reads the stored turns, the newest ones that fit the ask's `maxInputChars` (50,000 by default), opening on a visitor's message; two turns of one role left side by side, once a turn with no text between them is left out, are read as one. Files are posted with their message and read once: the server keeps the text of each turn, the sources it cited and, for a reply, the tool calls it made with the results the model was told, never files. The next ask replays each earlier reply as the provider saw it (the calls, then their results, then its text, or `(no answer was given)` for a reply that said nothing), so a follow-up can use a figure a tool already gave instead of calling it again or guessing; the Chat itself loads and shows the text alone. When the turns outgrow `maxInputChars`, the results of the oldest turns shrink to `(left out)` first, the latest exchange's never, then the oldest turns leave whole. A regenerate or an edit drops the calls of the turns it replaces with their text. A stored result is cut at 4,000 characters, and sits at rest in the store like the text of a turn.

### Listing the conversations

`conversations` keeps them on the server as `keepOnServer` does and lists the visitor's 100 latest beside the chat, the most recently updated first, under a New conversation link:

```kay
Chat(action={reply} conversations fill)
```

- Each row is a link to the conversation, titled by the opening words of its first message, with a rename button that turns it into a field (Enter or leaving the field saves, Escape cancels) and a delete button that asks before it deletes for good. The current one is `aria-current="page"`. The log is `aria-busy` while a conversation is read.
- Below `48rem` the list sits above the chat and scrolls past `12rem`; wider, it takes the side.

### A chat on every page

`conversationIn="browser"` names the conversation shown in this browser's localStorage, under `kai-chat-conversation:` and the action's URL, instead of the address, for a chat that is on every page of the site, whose address names none: a reload, another page, a new tab or a later visit shows it again. The list's rows and its New conversation entry are then buttons, not links, so choosing one swaps no page, the current row `aria-current="true"`. The id names nothing to another visitor, as the server only answers its owner. `ChatLauncher` sets it, so `ChatLauncher(action={reply} conversations)` is all a site's floating chat needs, its list heading the panel and scrolling past `8rem`, at the side once the panel is enlarged on a window `48rem` wide or wider. Two tabs each show the conversation they opened, and a switch in one does not follow in the other.

## Reference

### Rules that are easy to get wrong

- The action returns `ask`'s reply for every post, as the plain arrow does: a load, the list, a rename and a delete go through the same action and are answered by `ask` with no model asked, and an action answering something else for them leaves the chat saying it could not load. `resuming()` is true for them, so an action doing work around `ask` skips it with `if (resuming()) return ask(messages)`. An action calling `ask` twice holds the conversation in the first.
- A visitor's first 10 reads under one action every 10 minutes (a page opening makes two, the conversation and the list) give back the attempt the action's `rateLimit` counted, and later ones stay counted, so the handler's code before `ask` cannot be replayed through reads without limit; this process counts them in memory. Nothing counts against `ai()`'s limits or budget; a send, a rename and a delete count as usual. A `?conversation=` value no Chat made, or a header that does not parse, is a read of no conversation, never a question to the model.
- A tab left open on a conversation another tab has since written to cannot write over it: its send is refused with 409 (`AiError` kind `conflict`) before the model is asked, its message goes back to the field, and the chat shows the conversation as stored with `conflictLabel`. Each write raises the conversation's revision, which the chat posts and the server checks in one transaction. A send right after a Stop waits for the stopped reply to be stored first, up to 2 seconds, when this process stores it. When two tabs send at the same moment, the reply of the one whose write lost is shown but not kept, and its next send meets the 409, as each stored turn names the reply that wrote it and each send the last reply the chat counted.
- A reply of an ask with [`outlive`](chat.md#a-reply-that-outlives-the-page) still running at a reload is picked back up with no `remember`: the load shows the stored turns and the message being answered, and the chat asks for the reply again, so its stream goes on, and its next send counts it once stored. A second tab opening the conversation then follows the reply too. The server keeps that reply in this process's memory for half an hour: a restart loses it with the message it answers, and the chat shows the conversation as stored, and a resume that finds it gone puts the message back in the field. Without `outlive` the reload stops the reply, stored as stopped once it said something. Renaming keeps a conversation's place in the list.

### Words and parts

- Words: `conversationsLabel` (`Conversations`, names the list), `untitledLabel` (`Untitled conversation`, a conversation opened on files alone), `renameLabel` (`Rename the conversation`) and `deleteLabel` (`Delete the conversation`), each button followed by the conversation's title, `deleteConfirmLabel` (`Delete for good?`), `conflictLabel` (`This conversation changed in another tab, so it was reloaded.`), `loadFailedLabel` (`The conversation could not be loaded.`), `changeFailedLabel` (`The change could not be saved.`) and `signedOutLabel` (`You are signed out, so this conversation is no longer saved.`), under `ai.chat.conversations`, `untitled`, `rename`, `delete`, `deleteConfirm`, `conflict`, `loadFailed`, `changeFailed` and `signedOut`; the New conversation link reads `newLabel`. kayjs-ai ships the French.
- Parts: `conversations` (the `nav`), `newConversation`, `conversationList`, `conversation` (a row, `data-current` on the shown one), `conversationLink`, `renameField`, `rename`, `delete`, `deleteConfirm` and `confirm`, restyled as the rest of `Chat`'s ([Restyle](chat.md#restyle)).

### The store

- By default the conversations are kept in `data/ai-conversations.sqlite`, opened by the first one stored, in memory under `bun test`. An owner keeps at most 200 conversations under one action, the least recently updated going first, and a conversation its 500 latest turns.
- `ai({ conversations })` takes a store of your own, a `ConversationStore` (`list`, `get`, `write`, `rename`, `remove`, each async): `write(key, revision, change)` applies `{ drop, add, title }` only when the conversation is still at `revision` (0 for a new one) and answers the new revision, or `undefined` when another write came first. A store keeps every field of a turn as given, `steps` (the tool calls of a reply) included, or replay is lost without an error. The turns `add` holds name the Chat's reply that wrote them (`reply`), which the store keeps with each turn and `get` gives back, so a tab whose write lost is refused its next send; a store dropping it lets that send through. `sqliteConversations(path)` builds the default on another file.

```ts
import { ai, sqliteConversations } from '@kaynooo/kayjs-ai'
import { defineConfig } from 'kay/server'

export default defineConfig({ extensions: [ai({ conversations: sqliteConversations('data/chats.sqlite') })] })
```

- What is stored is personal data: see [Personal data](personal-data.md#what-kayjs-ai-keeps).

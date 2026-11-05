# Chat blocks

## Common tasks

### Show a tool's result as a card

`@call(call)` draws each tool call in place of the folded list, given the call as plain data (`name`, `input`, `status`, `result`). The block is written in a component of your own (`reply` is the page's streaming action), as the chat is an island and a block with parameters cannot be sent to the browser from a page or a layout.

```kay
---
import { reply } from '../routes/chat.kay'
import Chat from '@kaynooo/kayjs-ai/chat.kay'
---
Chat(action={reply} label="Assistant")
  @call(call)
    if call.status === 'running'
      p Looking up {call.name}...
    else if call.result !== undefined
      article.order-card
        h3 {call.name}
        pre {call.result}
```

### Add buttons under a reply

`@actions(turn)` adds markup to the row of buttons under every finished turn, after the chat's own (regenerate, edit). It is given the turn as a `ChatTurnView`.

```kay
---
import { reply } from '../routes/chat.kay'
import Chat from '@kaynooo/kayjs-ai/chat.kay'
import Button from '@kaynooo/kayjs-ui/button.kay'
---
Chat(action={reply} label="Assistant" regenerate)
  @actions(turn)
    if turn.role === 'assistant'
      Button(variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(turn.content)}) Copy
```

### Draw the empty chat

`@empty(chat)` replaces the greeting and the suggestions, and `chat.send(text)` posts a message as a clicked suggestion does.

## Reference

- The blocks, each falling back to the chat's own drawing when absent: `@turn(turn, index)`, `@actions(turn)`, `@call(call)`, `@source(source, n)`, `@empty(chat)` and `@footer`.
- `turn` is a `ChatTurnView`, `{ role, content, sources?, calls, stopped, pending }`, a copy of the data and not the chat's internal state. `call` is an `AiToolCall` and `source` a `Source`, both from `@kaynooo/kayjs-ai`.
- `@turn` replaces what is inside a turn: the reasoning, the tool calls, the text, the cited sources and the note of a stopped reply, or a user message and its files. It is also given the turn being written (`pending`, its `content` growing, `index` the log's length), which the chat hides from screen readers until it is whole. The chat keeps the turn's element (`part="turn"`, `data-role`), the log (`role="log"`, its follow-scroll and the status line that announces each finished turn and each tool call), the Allow and Deny buttons of a held tool call, the regenerate and edit buttons, and the field an edit opens.
- `@actions` is given finished turns only, of both roles, and its row (`part="actions"`) is drawn for every turn once the block is given, empty when the block draws nothing for a turn: return markup for the roles you mean.
- `@turn` is called again on every streamed token for the turn being written, so keep no local state in it and draw nothing focusable when `turn.pending`, as that turn is hidden from assistive technology. The turn omits the reasoning and the files of a user message. The Allow and Deny buttons of a held call stay the chat's: after the default's calls, or after your markup under `@turn`. `content` never holds the approval ticket.
- `@call` replaces the folded line and the list of calls of a turn, including the turn being written: it is called again as a call's status or result changes. `toolLabels`, `toolDetails` and the status labels apply to the default only, and the list is a plain `div.kai-chat-calls` the app styles, without the muted small text of the folded line. A call held for the visitor's yes still shows its Allow and Deny buttons.
- `@source` replaces the link of each source in the list, which keeps its `ol`, its label and each item's number; the `[n]` links in the text stay.
- `@footer` sits under the form, inside the chat's root.
- `ChatLauncher` takes the same six blocks and passes them to its chat. The block is a function, so the component writing it renders as an island, as for any block with parameters; a launcher given none stays static.
- `ChatPanel` is the launcher's shell around the chat and draws none of these.

### Change the icons

`icons` names an icon for each round button, by the name of the button: `Chat(action={reply} icons={{ send: ArrowUp, stop: PlayerStopFilled }})`, each an icon of the app's settings or one imported from `~icons/<prefix>/<name>`, as `Icon` takes it. Only the names given change.

- A `Chat` takes `send`, `stop`, `new`, `attach`, `regenerate`, `edit` and `record`; a `ChatLauncher` takes those and `open`, `close`, `expand` and `collapse` for its button and its panel's header.
- Before 1.90 each was a block of its own, `@sendIcon`, `@stopIcon`, `@newIcon`, `@attachIcon`, `@regenerateIcon`, `@editIcon` and `@recordIcon`, and the launcher's `@icon`, `@closeIcon`, `@expandIcon` and `@collapseIcon`. They work until 1.93 and win over `icons`; `kay check` reports them as `deprecated-chat-icons`, with no fix, as a block holds any markup.

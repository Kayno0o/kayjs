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
- `turn` is a `ChatTurnView`, `{ role, content, sources?, calls, stopped, pending }`, a copy of the data and not the chat's internal state. `call` is a `ToolCall` and `source` a `Source`, both from `@kaynooo/kayjs-ai`.
- `@turn` replaces what is inside a turn: the reasoning, the tool calls, the text, the cited sources and the note of a stopped reply, or a user message and its files. It is also given the turn being written (`pending`, its `content` growing, `index` the log's length), which the chat hides from screen readers until it is whole. The chat keeps the turn's element (`part="turn"`, `data-role`), the log (`role="log"`, its follow-scroll and the status line that announces each finished turn and each tool call), the Allow and Deny buttons of a held tool call, the regenerate and edit buttons, and the field an edit opens.
- `@actions` is given finished turns only, of both roles, and shows its row when the block is given even if the chat has no button of its own to show.
- `@call` replaces the folded line and the list of calls of a turn, including the turn being written: it is called again as a call's status or result changes. `toolLabels`, `toolDetails` and the status labels apply to the default only. A call held for the visitor's yes still shows its Allow and Deny buttons.
- `@source` replaces the link of each source in the list, which keeps its `ol`, its label and each item's number; the `[n]` links in the text stay.
- `@footer` sits under the form, inside the chat's root.
- `ChatLauncher` takes the same six blocks and passes them to its chat. The block is a function, so the component writing it renders as an island, as for any block with parameters; a launcher given none stays static.
- `ChatPanel` is the launcher's shell around the chat and draws none of these.

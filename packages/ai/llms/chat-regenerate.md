# Regenerating and editing

## Common tasks

- Put a chat on a page and choose what it shows: the tasks of [Chat](chat.md#common-tasks).

## Reference

### Regenerating and editing

`regenerate` adds a button under the last reply that asks again for it, and `editable` one on each message of the visitor that turns it into a field to change and send again. Both are off by default.

```kay
Chat(action={reply} regenerate editable)
```

- A regenerated reply leaves the log and the history, reasoning, tool calls and code with it, and the history is posted again ending on the message before it. An edited message and every turn after it leave, and the history is posted ending on the new message. A message keeps the files it had while the page holds them; a restored one has none. Enter saves an edit, Escape cancels it.
- Regenerate is not offered for a reply that waits for the visitor's allowance, nor after an answer to a held tool call, whose approval is spent, and edit is not offered on such an answer. Nothing is offered while a reply is under way; a kept reply that resumes after a reload ends before the buttons come. A regenerate or an edit stopped, or refused (422), before the first word puts the history back as it was, the edited text returning to the field.
- A server that keeps the conversation tells these posts from a fresh send with `replaces()` (`@kayjs/ai`), read from the `x-kai-replaces` header, which no schema has to take: `{ kind: 'regenerate' | 'edit', turns }`, or `undefined` for a fresh send. `turns` counts the trailing turns the chat showed that the post supersedes, its last message included (a regenerate is `2`: the reply and the message posted again; an edit of the third of five turns is `3`). One rule serves both: drop that many stored turns, append the last posted message, answer. The count is of the turns the chat shows, so a server that stores less (a reply that only called tools has no text to post, and a reload with `remember` restores text turns only) clamps it to what it holds; the value comes from the browser. It assumes the server stored the message a Try again or an edit of the last message answers. A chat that is posted the whole history needs nothing.

```ts
export const reply = action(schema, async ({ messages }) => {
  const dropped = replaces()?.turns ?? 0

  await conversation.dropLast(dropped)
  await conversation.add(messages.at(-1)!)

  return ask(await conversation.messages())
})
```

- Try again after a failed regenerate or edit posts the same request with the same header, as a fresh send's retry posts its message again; a Stop before the first word puts the history back and forgets it. A resume after a reload carries none, the server having dropped the turns by then.
- An edit stays open through a message sent from outside, an Allow or Deny and the reply to it, its Save disabled while a reply is under way. Cancel, Escape (in the field or on Save or Cancel, which neither stops a reply nor closes a `ChatLauncher` panel) and Save close it: Cancel and Escape put the focus back on the message's edit button, which is named `Edit the message: <first words>`; Save focuses the field, as the reply is under way. A Save with no text and no file says `ai.chat.editEmpty` (`Write a message to send.`, `editEmptyLabel`), and Enter in the field while a reply is under way says `ai.chat.editBusy` (`Wait for the reply to finish.`, `editBusyLabel`) until the reply ends. The name cuts the message between graphemes, so an emoji is never split.
- Words: `ai.chat.regenerate` (`Regenerate the reply`), `edit` (`Edit the message`), `save` (`Save and send`) and `cancel`, props `regenerateLabel`, `editLabel`, `saveLabel` and `cancelLabel`; `icons.regenerate` and `icons.edit` replace the circular arrow and the pencil (kayjs-ui's `refresh` and `edit` slots); `ChatLauncher` takes them too.

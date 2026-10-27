# kayjs-ai: Actions as tools

## Common tasks

### Offering actions

Pass actions in `tools` and the model can call them:

```kay
--- server
import { s } from 'kay'
import { ask } from '@kaynooo/kayjs-ai'

export const addNote = action(s.Object({ title: s.String({ minLength: 3, maxLength: 100 }) }), ({ title }) => saveNote(title), { tool: 'Adds a note to the visitor\'s list' })

export const assistant = action(s.Object({ messages: s.Array(s.Object({ role: s.UnionEnum(['user', 'assistant']), content: s.String({ maxLength: 4000 }) }), { minItems: 1, maxItems: 40 }) }), ({ messages }) => ask(messages, { tools: [addNote], maxSteps: 4 }).progress())
---
p Assistant
```

### Allowing a write

An action that changes something waits for the visitor by default (a function tool does not). The call does not run: the model is told it needs the visitor's approval, the reply's `ToolCall` carries an `approval` ticket, and `Chat` draws Allow and Deny under the turn. Allow posts the visitor's next message, `Allowed: add_note {"title":"Milk"}` with the ticket on a last line the chat does not show, and the model calls the tool again: the ticket lets that very call run once, and no other tool, arguments or later message. Deny posts `Denied: add_note`. A ticket is signed with the app secret (set `KAY_SECRET`, or it works in one process only), expires after 10 minutes, is spent by its first use (in the app's `store.rates` when it has one) and counts only in the visitor's last message, so text a tool returned or the model wrote cannot allow anything, and posting the same message again holds the call again.

A tool that only reads says so and runs unasked: `action(schema, handler, { tool: { description: 'Looks a note up', readOnly: true } })`. `confirm: false` in `ask` runs every tool unasked, for an app asking elsewhere. The arguments are part of the message the action receives, so a schema bounding `content` leaves room for them (4,000 characters is plenty for a note, not for a long text argument).

### Confirming a call yourself

`ask(messages, { tools, confirm })` calls `confirm({ name, input, request })` before each call runs, `name` being the tool's (`book_slot`): only `true` lets it through. Anything else, such as `false`, runs nothing and tells the model `The visitor has not confirmed this call, so it did not run; ask them, then call it again`; a throw fails the call like a tool that throws. A read answers `true`, a write checks what the visitor agreed to, such as that their last message says yes (all `Chat` posts is the messages), or, from a page of your own, a token issued after a button. A `confirm` function replaces the Allow button for every action of that ask; a [function tool](#function-tools) is never asked.

```ts
ask(messages, { tools: [findSlot, bookSlot], confirm: ({ name }) => name === 'find_slot' || lastSaysYes(messages) })
```

### Showing the calls

`reply.progress()` streams the text and the calls of the reply:

```ts
for await (const { text, calls } of ask(messages, { tools: [addNote] }).progress())
  console.log(text, calls.map(call => `${call.name}:${call.status}`))
```

### Testing

```ts
fakeAi.reply({ text: 'Adding. ', calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
fakeAi.reply(asked => `Added: ${asked.messages.at(-1)!.results![0]!.content}`)

const outcome = await site.call(assistant, { messages })
```

`fakeAi.asked[0].tools` is what was offered. A string `input` plays a model's invalid JSON and `name` one that does not exist. Use `testSite` from `kay/test`, which answers the call as a visitor whose headers you set (`{ headers: { authorization } }`).

## Reference

### Offered actions

- `tools` takes actions exported by page modules. Passing one is its opt-in: the model is offered those and no other, and a name it invents is an unknown tool.
- Each tool is described as `/mcp` describes it: the name from the export (`addNote` is `add_note`), the description from the action's `tool` option (a string or `{ name, description }`), else its name as a sentence, and the input schema from the action's schema. `tool: false`, an action taking a file and one of a page with params cannot be a tool: `ask()` throws a `config-invalid` `KayError` naming the index.
- Each call runs as the visitor, through the whole app as a form post does: guards, validation and rate limits apply, while the honeypot, minimum time and proof of work are skipped. A request a browser sent from another site is refused. The visitor's cookies and headers are used, so an anonymous visitor gets a guarded action refused.
- `ask()` with an action needs the request being answered (a page, an action or a handler kay is answering), and throws without one; the action keeps running as that visitor after the answer is sent, while a reply streams on. An API route's handler runs outside that context, so offer actions from an action, or [function tools](#function-tools).

### Function tools

A scheduled job or a queue worker has no visitor to run an action as. `tool({ name, description, input, run })` (from `@kaynooo/kayjs-ai`) makes a tool of a plain function, which `tools` takes beside actions and which works with or without a request:

```ts
const findArticle = tool({ name: 'find_article', description: 'Finds an article by its title', input: s.Object({ title: s.String() }), run: ({ title }) => articles.find(title) })

await ask('Write the episode', { tools: [findArticle], key: 'podcast' })
```

- `name` is letters, digits, `_` and `-` up to 64 characters and unique among the tools of an ask (a clash or a bad one throws a `config-invalid` `KayError`); `input` is an `s.Object` and `run(input, { signal })` gets it checked and typed.
- It runs as nobody: the app's own rights, no cookies, no guards, no rate limit of an action. Passing it is the opt-in, so it is never held for approval and `confirm` is not called for it (`confirm` still governs the actions of the same ask), even in a visitor's chat, where the model picks its arguments from text a visitor or a fetched page wrote: it must be safe for any input, or check inside `run`.
- The result is the returned string, or the JSON of any other value, cut at 20,000 characters. An input the schema refuses is answered `The arguments do not fit the tool: title (...)` and `run` is not called; a throw is `The tool could not run`, the error going to the logger `kayjs-ai`. `signal` aborts with the reply.
- `maxSteps`, `outlive` and `reply.progress()` work as for actions. With no request, `ai({ budget, rateLimit })` count the ask's `key` and `total` counts always ([limits](limits.md)).
- `fakeAi` scripts calls to a function tool as to an action: `fakeAi.reply({ calls: [{ name: 'find_article', input: { title: 'Moon' } }] })`.

### The loop

`ask` requests the provider, runs the tools the model called one after another, sends their results back and requests again, until the model answers without a call or `maxSteps` requests were made (5 by default, a whole number of 1 or more). When the last request still calls tools, those calls are not run and `await reply.finish` is `steps`. A step the provider cut short (`length`, `filtered`) runs none of its calls, which may be half written, and the reply ends with that finish.

- The text of the reply is the text of every step, a blank line between two steps' texts. `usage` is the sum of the steps.
- The visitor leaving, `reply.stop()`, `options.signal` or a reader leaving early end the loop: a call already running finishes (an action cannot be cancelled) and its result is dropped, and no further call is run and no further request made. With `outlive: true` only `reply.stop()` and `options.signal` end it: the visitor leaving lets the loop run every call and request to the end, so a reload mid-reply loses no tool call's story ([a reply that outlives the visitor](asking.md#a-reply-that-outlives-the-visitor)).
- A provider failing in any step fails the reply with its `AiError`.
- A provider that reports no token count for a step leaves it out of the sum.
- With `ai({ budget })` the tokens of every step count, and the reply holds `maxTokens` times `maxSteps` against the budget while it runs ([limits](limits.md)).

### What the model is told when a call goes wrong

Every failure is a result with `ok` false, in words the model can correct from, never an exception, so the loop goes on:

| case | result |
| --- | --- |
| arguments not valid JSON, or not a JSON object | `The arguments are not valid JSON`, `The arguments must be a JSON object` |
| arguments over 65,536 characters | `The arguments are too long` |
| unknown name | `There is no tool named "x"; the tools are add_note, ...` (name cut at 64 characters; a tool name streamed past 256 characters stops growing and names no tool) |
| more than 16 calls in one step | the 17th gets `Too many tool calls in one step` and none after it run |
| schema refused | the action's `{"status":422,"errors":{...}}`, so the model can fix the field |
| guard refused, rate limited, `ctx.fail`, redirect | the action's answer (`Sign in`, a 429, a redirect sentence) |
| the action threw | kay's own 500 answer (`Something went wrong on our side...`), never what it threw, which kay logs as for any action |
| the call itself threw | `The tool could not run`, logged by the app's logger (`kayjs-ai`) |

A result over 20,000 characters is cut. A success is the text kay's MCP tool call returns for the action. Calls of a step run in order, one at a time. A call the model repeats an id for, or leaves it out, gets a new unique id. The calls go back to the provider with their arguments as the parsed object (`{}` when they were not one), never the text a model garbled.

### What the model can be made to do

A model reads text an attacker may have written (a page, an email, a visitor's message), and can be talked into calling any action in `tools`. Offer only actions whose worst call is acceptable for the visitor running it, and keep destructive ones out of `tools` or behind a guard that asks for more than a signed-in visitor. A write is held for the visitor's Allow by default ([above](#allowing-a-write)), which a prompt injected through a page or a tool result cannot give.

### The calls shown

- `reply.progress()` is an async iterable of `{ text, calls, code?, reasoning? }`, the text so far and every call as last seen, one snapshot per change; `code` lists the blocks highlighted since the previous snapshot ([Chat island](chat.md)). It is plain data: an action returning it streams both to the island (`last()` is the latest), which is what a chat renders. `code` holds only the blocks closed since the previous snapshot, so `last()` is not the whole list.
- `await reply.calls` is the final `ToolCall[]`, never rejects; reading it starts the reply.
- `ToolCall` is `{ id, name, input, status, result? }`: `input` the parsed arguments (`{}` when they were not an object), `status` `running`, then `done` or `failed`, `result` the text the model was given. A call stopped while running stays `running`.
- Results are the visitor's own data, run as them, but shown as is: a chat decides how much of `result` to render.

### Both providers

Anthropic gets `tools` with `input_schema`, the assistant's `tool_use` blocks and the user's `tool_result` blocks (`is_error` when not `ok`). OpenAI-compatible servers get `tools` as functions, the assistant's `tool_calls` and one `tool` message per result; argument deltas are joined by index and a server sending a call whole, or with no id, works. A provider built by hand yields `{ toolUse }` pieces ([The fake, errors and providers](testing-and-errors.md)).

# kayjs-ai: Actions as tools

## Offering actions

```kay
--- server
import { s } from 'kay'
import { ask } from '@kaynooo/kayjs-ai'

export const addNote = action(s.Object({ title: s.String({ minLength: 3, maxLength: 100 }) }), ({ title }) => saveNote(title), { tool: 'Adds a note to the visitor\'s list' })

export const assistant = action(s.Object({ messages: s.Array(s.Object({ role: s.UnionEnum(['user', 'assistant']), content: s.String({ maxLength: 4000 }) }), { minItems: 1, maxItems: 40 }) }), ({ messages }) => ask(messages, { tools: [addNote], maxSteps: 4 }).progress())
---
p Assistant
```

- `tools` takes actions exported by page modules. Passing one is its opt-in: the model is offered those and no other, and a name it invents is an unknown tool.
- Each tool is described as `/mcp` describes it: the name from the export (`addNote` is `add_note`), the description from the action's `tool` option (a string or `{ name, description }`), else its name as a sentence, and the input schema from the action's schema. `tool: false`, an action taking a file and one of a page with params cannot be a tool: `ask()` throws a `TypeError` naming the index.
- Each call runs as the visitor, through the whole app as a form post does: guards, validation and rate limits apply, while the honeypot, minimum time and proof of work are skipped. A request a browser sent from another site is refused. The visitor's cookies and headers are used, so an anonymous visitor gets a guarded action refused.
- `ask()` with tools needs the request being answered (a page, an action or a handler kay is answering), and throws without one; the tools keep running as that visitor after the answer is sent, while a reply streams on. An API route's handler runs outside that context, so offer tools from an action.

## The loop

`ask` requests the provider, runs the tools the model called one after another, sends their results back and requests again, until the model answers without a call or `maxSteps` requests were made (5 by default, a whole number of 1 or more). When the last request still calls tools, those calls are not run and `await reply.finish` is `steps`. A step the provider cut short (`length`, `filtered`) runs none of its calls, which may be half written, and the reply ends with that finish.

- The text of the reply is the text of every step, a blank line between two steps' texts. `usage` is the sum of the steps.
- The visitor leaving, `reply.stop()`, `options.signal` or a reader leaving early end the loop: a call already running finishes (an action cannot be cancelled) and its result is dropped, and no further call is run and no further request made.
- A provider failing in any step fails the reply with its `AiError`.
- A provider that reports no token count for a step leaves it out of the sum.
- With `ai({ budget })` the tokens of every step count, and the reply holds `maxTokens` times `maxSteps` against the budget while it runs ([limits](limits.md)).

## What the model is told when a call goes wrong

Every failure is a result with `failed` set, in words the model can correct from, never an exception, so the loop goes on:

| case | result |
| --- | --- |
| arguments not valid JSON, or not a JSON object | `The arguments are not valid JSON`, `The arguments must be a JSON object` |
| arguments over 65,536 characters | `The arguments are too long` |
| unknown name | `There is no tool named "x"; the tools are add_note, ...` (name cut at 64 characters) |
| more than 16 calls in one step | the 17th gets `Too many tool calls in one step` and none after it run |
| schema refused | the action's `{"status":422,"errors":{...}}`, so the model can fix the field |
| guard refused, rate limited, `ctx.fail`, redirect | the action's answer (`Sign in`, a 429, a redirect sentence) |
| the action threw | kay's own 500 answer (`Something went wrong on our side...`), never what it threw, which kay logs as for any action |
| the call itself threw | `The tool could not run`, logged by the app's logger (`kayjs-ai`) |

A result over 20,000 characters is cut. A success is the text kay's MCP tool call returns for the action. Calls of a step run in order, one at a time. A call the model repeats an id for, or leaves it out, gets a new unique id. The calls go back to the provider with their arguments as the parsed object (`{}` when they were not one), never the text a model garbled.

## What the model can be made to do

A model reads text an attacker may have written (a page, an email, a visitor's message), and can be talked into calling any action in `tools`. Offer only actions whose worst call is acceptable for the visitor running it, and keep destructive ones out of `tools` or behind a guard that asks for more than a signed-in visitor.

## Showing the calls

- `reply.progress()` is an async iterable of `{ text, calls, code? }`, the text so far and every call as last seen, one snapshot per change; `code` lists the blocks highlighted since the previous snapshot ([Chat island](chat.md)). It is plain data: an action returning it streams both to the island (`last()` is the latest), which is what a chat renders.
- `await reply.calls` is the final `ToolCall[]`, never rejects; reading it starts the reply.
- `ToolCall` is `{ id, name, input, status, result? }`: `input` the parsed arguments (`{}` when they were not an object), `status` `running`, then `done` or `failed`, `result` the text the model was given. A call stopped while running stays `running`.
- Results are the visitor's own data, run as them, but shown as is: a chat decides how much of `result` to render.

```ts
for await (const { text, calls } of ask(messages, { tools: [addNote] }).progress())
  console.log(text, calls.map(call => `${call.name}:${call.status}`))
```

## Both providers

Anthropic gets `tools` with `input_schema`, the assistant's `tool_use` blocks and the user's `tool_result` blocks (`is_error` when failed). OpenAI-compatible servers get `tools` as functions, the assistant's `tool_calls` and one `tool` message per result; argument deltas are joined by index and a server sending a call whole, or with no id, works. A provider built by hand yields `{ toolUse }` pieces ([The fake, errors and providers](testing-and-errors.md)).

## Testing

```ts
fakeAi.reply({ text: 'Adding. ', calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
fakeAi.reply(asked => `Added: ${asked.messages.at(-1)!.results![0]!.content}`)

const outcome = await site.call(assistant, { messages })
```

`fakeAi.asked[0].tools` is what was offered. A string `input` plays a model's invalid JSON and `name` one that does not exist. Use `testSite` from `kay/test`, which answers the call as a visitor whose headers you set (`{ headers: { authorization } }`).

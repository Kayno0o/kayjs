# kayjs-ai: Limits and the token budget

A public chat is paid for by whoever runs it. `ai()` in `kay.config.ts` sets what one visitor, and all of them together, may spend; `ask` reads it with nothing passed per call.

```ts
// kay.config.ts
import { ai } from '@kaynooo/kayjs-ai'
import { sqliteRates } from 'kay/server'

export default defineConfig({
  extensions: [ai({
    limit: { max: 10, window: '1m' },
    budget: { tokens: 50_000, total: 2_000_000, window: '1d', store: sqliteRates('data/ai.sqlite') },
    visitor: request => request.headers.get('x-user') ?? undefined,
  })],
})
```

## The options

- `limit: { max, window, store? }`: at most `max` asks per visitor every `window`. Counted when the reply is first read, so a reply never read counts nothing.
- `budget: { tokens, total?, window, store? }`: the tokens (input plus output) the replies to one visitor may use every `window`, and across all visitors with `total`. `tokens` and `total` are whole numbers of at least 1.
- `visitor: (request) => string | undefined`: who a signed-in visitor is, such as their user id; sync or async. kay's core has no notion of a user and its own rate limits count the address, so this is the one hook; without it, or when it returns nothing, the address counts, one key per IPv6 /64 as `rateLimit` does behind `proxy`. A user and an address never share a key.
- `store`: a `RateStore`, in this process's memory unless given. `sqliteRates(path)` or an app's own store keeps the count over a restart and shares it between processes. The budget's store must have `peek(key)` (`memoryRates` and `sqliteRates` do), else `ai()` throws.
- `ask(..., { visitor: 'id' })` names the visitor for one ask, in place of the hook: a job, a test.
- With no request being answered and no `visitor`, the per-visitor `limit` and `budget` are skipped and `total` still counts, so a background job spends the shared budget but is never one visitor's.

## When it counts

- Before the provider is called, `limit` is hit (a refused ask counts, as an action's `rateLimit` does) and the budget is read without counting.
- When the reply ends, finished, failed or stopped, its tokens are added with the provider's `usage` as the weight. With no usage reported, the characters sent and received stand for it (4 per token); a reply that failed before any text and any usage counts nothing.
- A reply that overruns the budget mid-stream finishes, bounded by its input and `maxTokens`, and all of it is counted; the next ask is refused. A reply ending after its window rolled over counts in the new window.
- Asks started together all pass the check before any ends, so a burst passes `budget` by the replies in flight: set `limit` beside it, which is atomic and bounds how many start.
- Tokens, not money: prices change too often to ship a table; set `tokens` from the price of the model you use.

## Over a limit

`ask` fails with an `AiError` of kind `limited`, `retryAfter` (seconds until the window closes) and `limit`: `asks`, `budget` or `total`. Nothing is sent to the provider.

An action letting it out answers 429 with `Retry-After`, as its own `rateLimit` does, and a chat shows the message (`Too many questions; try again in 12 s`, or the action's `messages.rateLimit` wording given the seconds). Any error carrying `Symbol.for('kay.refused')` as `{ status, retryAfter?, message }` is answered this way. In a page's `await` block it is the `catch` branch.

## When the store fails

- Reading it before an ask fails the ask with kind `unavailable`: a public chat does not run unlimited because its limit could not be read. `cause` holds the store's error.
- Counting the tokens afterwards fails nothing, as the reply was given; the failure is logged (`kayjs-ai`) and those tokens are lost.

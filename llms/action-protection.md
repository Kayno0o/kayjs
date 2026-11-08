# Protecting actions and limiting requests

- [Actions](actions.md): declaring an action and posting a form to it.
- [Calling actions from islands](actions-from-islands.md): `pending()`, `track()`, optimistic changes and streaming answers.
- [Protecting actions](action-protection.md): cross-site posts, honeypot, minimum time and proof of work; [Rate limits](rate-limits.md) holds every rate limit.

## Common tasks

### Keep scripts from flooding a form

A third argument limits attempts and traps bots, its `protect` group holding `rateLimit` answering 429 past `max` posts every `window` and `honeypot` failing a form that fills a hidden field:

```kay
--- server
import { s, action } from 'kay'

export const contact = action(
  s.Object({ message: s.String({ maxLength: 2000 }) }),
  async ({ message }) => message.length,
  { protect: { rateLimit: { max: 5, window: '1m' }, honeypot: 'website', minTime: '3s' } },
)
---
form(action={contact})
  textarea(field="message")
  error
  button Send
```

### Limit attempts in a guard or an API route

See [Rate limits](rate-limits.md#limit-attempts-in-a-guard-or-an-api-route).

## Reference

### Cross-site posts

- A post another site sends, as its `Origin` or `Sec-Fetch-Site` header shows, is refused with 403.
- On a site served over https (the request itself, `X-Forwarded-Proto: https`, or an https `site` in production), an `http:` `Origin` of the site's own host is refused too, as a downgrade; `localhost`, `127.x` and `[::1]` are exempt, so `kay dev` and a production build tried locally keep working.
- The 403 is `text/plain` and says what it saw: `Cross-site action refused: Origin http://localhost:4701 is not this site (http://127.0.0.1:4701; set or fix site in kay.config.ts if a proxy changes the host)`, or `Sec-Fetch-Site is cross-site and the request has no Origin, not same-origin or none`; the echoed header is stripped of control and bidi characters and cut at 100 without splitting a character, and an empty `Sec-Fetch-Site` with no `Origin` reads `the request sent an empty Sec-Fetch-Site and no Origin`. The same text, `request` for `action`, refuses an api route.
- A post from the host of `site` in kay.config.ts is the site's own, so a proxy that does not pass the browser's `Host` on, and nginx leaves it out unless told `proxy_set_header Host $host`, refuses none.

### Protecting an action

- A third argument protects an action from scripts: `action(schema, handler, { protect: { rateLimit: { max: 5, window: '1m' }, honeypot: 'website' } })`.
- Its options are grouped by concern: `protect` holds `rateLimit`, `honeypot`, `minTime` and `proofOfWork`, beside `messages`, `tool` and `maxSize`. The four on the third argument itself, the form before 1.71, are no longer read since 1.74, and `kay check` reports them as a type error.
- None of these reaches the handler.

#### Rate limits


- `rateLimit` lets one client post `max` times every `window`, then answers 429 with `Retry-After`; counting, keys and stores are in [Rate limits](rate-limits.md#on-an-action).

#### Honeypot

- `honeypot` names a field a form posting to the action renders by itself as its first child, out of sight, out of the tab order, hidden from screen readers and marked for 1Password, LastPass and Bitwarden to skip, which people leave empty and bots fill in.
- A form post giving it any value, a file included, fails with 422 and `errors.website`.
- It is hidden by a `style` attribute, which a `csp` dropping `style-src 'unsafe-inline'` would leave visible.
- A page writing the field itself as well renders it twice, which still posts empty.
- A form inside an island renders it itself, as its markup is claimed node by node when it hydrates: `div(style="position:absolute;left:-9999px" aria-hidden="true" inert)` around `input(name="website" tabindex="-1" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore)`, and `kay check` takes it as one of the form's fields.
- `honeypot: { field: 'website', pretend: true }` answers a bot filling it in as if its post went through instead, a call with no result and a plain form post going back to its page with `add.succeeded()` holding `data: undefined`, so the bot learns nothing to adjust.

#### Minimum time

- `minTime: '3s'` refuses a form posted sooner than that after its page rendered, with 422 and `errors['']`.
- A form posting to the action renders a hidden `kay_since` field by itself, a stamp of when it rendered bound to the action and signed with a key derived from [the app secret](environment.md#the-app-secret) (so an app without sessions needs no `session()` for one), else a key of the process, which a restart changes: a production server refuses to start on it unless `KAY_EPHEMERAL_SECRET=1`; a test server never does.
- A plain form post whose stamp is missing, forged, another action's or older than `maxAge`, a day by default, fails the same way, and the page it answers keeps the stamp the form rendered with, so the visitor does not wait again from zero.
- A prerendered page holding such a form is still rendered once: the server signs a fresh stamp into it on every visit, as it splices in an inline server island, so the page goes out gzipped rather than in brotli and kept by no cache.
- `minTime: { after: '3s', maxAge: '1h', pretend: true }` answers a post sent too soon as `honeypot`'s `pretend` does.
- A form the server renders inside an island carries its honeypot and stamp like any other. A form an island builds in the browser (a branch shown after a click) asks `/_kay/fields/` plus the action's path, a GET answering `{ html }`, the same markup with a stamp signed at that moment, when it takes focus or is posted, and adds it to the form before the post reads its fields: it costs no request on page load, no code on a page without such a form, and for a form of an action with neither check one cached request per action and no field. The stamp is dated from that first focus or post, not from when the form appeared, so a button-only form with `minTime: '3s'` clicked at once is refused as `early`: `plain: true` leaves a form the script posts unchecked. A form post with no stamp is refused; a call from kay's script without one goes through, a stamp it sends still checked.
- `minTime: { after: '3s', plain: true }` checks only a form the browser posts itself, without kay's script: the page swap's post and an island's call go through, for a form whose script already proves something, such as a `data-kay-work` field below: the header marking the swap's post proves nothing, so a script sending it skips `minTime`.
- `site.submit` from a `Visit` sends its form's stamp, and `setSystemTime` from `bun:test` moves the clock past `minTime`.

#### Offering an action to agents

- `tool` on the third argument offers the action as an MCP tool when `mcp: true` is set in kay.config.ts: `tool: true`, `tool: 'Create a note'` (its description) or `tool: { name: 'create_note', description: 'Create a note' }`. Without it an action is never offered.
- `tool: { label: 'Read the home' }` words the action's calls for a visitor: kayjs-ai's `Chat` shows it in place of the tool's name, and an agent never reads it ([Chat](../packages/ai/llms/chat.md)).
- `tool: { readOnly: true }` says the action only reads, so `/mcp` lists it with `readOnlyHint: true` and a client may approve it without a prompt, and kayjs-ai's `ask` runs it unasked while it holds every other tool for the visitor's yes ([Actions as tools](../packages/ai/llms/tools.md#allowing-a-write)).
- `tool: { text: notes => notes.map(note => note.title).join('\n') }` words the agent's answer from what the action returned (typed as it): the agent reads that text alone, with no JSON and no `structuredContent`, while the page and any other caller still get the object. A `text` that throws is the agent's refusal. Without it an object is sent as JSON in the text and as `structuredContent`, so a client reading either finds it. A route's `detail.tool` takes `text` too.
- `tool: { output: t.Object({ count: t.Number(), at: t.String() }) }` lists the tool's `outputSchema`, so a client knows what a call answers before it calls (an API route's object `response` does the same; a route's `detail.tool` takes no `output`). It is an object schema, `t.Object` or `t.Record`: the types refuse a union, an array or a primitive, which is not listed. It is the JSON the agent receives, so a `Date` is `t.String()`, a bigint a string, a `Map` an object and a `Set` an array, and `kay check` refuses an `output` the handler's return value does not fit. With one, the answer is always sent as `structuredContent`, beside the `text` when there is one; without it, `text` alone sends no `structuredContent`, and with neither the JSON text and `structuredContent` both go. Under `kay dev` an action's answer that does not match, or an action with an `output` that answers nothing, logs one warning naming the tool and the first path that differs, for a library's tool (`actionTool()`) served by the app as for the app's own; production checks nothing, and a route's `response` is validated by Elysia as it always was.
- An action that declares no `output` is listed with the `outputSchema` of its handler's return type, with nothing to declare: `kay build` reads it through tsgo (one declaration emit, only when a tool action asks for one, recorded as `tool-outputs.json` in the build output, so `kay start` runs no tsgo) and `kay dev` records it in the background after each type check, which `/mcp` lists at its next request. It is the JSON wire form (`Date` and bigint strings, `Map` an object, `Set` an array, a property that may be `undefined` optional), an object only: a string, array or union answer, a stream, `unknown`/`any` and a type that cannot be written as plain data list none, and a property of such a type is any value. A declared `output` wins, a build that cannot run tsgo or whose handler has a type error lists none, and a library's `actionTool()` keeps declaring its own. `NaN` and `Infinity`, which JSON writes as `null`, are described as numbers.
- The tool takes the action's schema as its input and runs the action as a call would, its guards, `rateLimit`, body limit and `ctx.locals` included; `honeypot`, `minTime` and `proofOfWork` are skipped. An action with a file in its schema is not offered.
- `kay check` warns (`unguarded-tool`) of such an action with one of those three and no guard; a guard or a `rateLimit` keeps it in hand. See [API routes](api-routes.md#mcp).

#### Refusal messages

- The refusals of these limits, and the one for a post over `maxSize`, read in English unless the site words them once for every action under `kay.protection.*` and `kay.action.*` in its catalogs ([Locales](locales-texts.md)), or `messages` gives an action's own, as a schema's `error` does for a field: `` messages: { honeypot: 'Laissez ce champ vide', minTime: reason => reason === 'early' ? 'Un instant, puis renvoyez-le' : 'Ce formulaire a expiré, renvoyez-le', rateLimit: wait => `Réessayez dans ${wait} s`, maxSize: bytes => `${bytes} octets au plus` } ``.
- `rateLimit` is given the seconds to wait.
- `minTime` is given `early` for a post sent too soon or `expired` for a stamp missing, forged or past `maxAge`, as a page from before a restart sends.
- `proofOfWork` is given `missing`, `expired` or `wrong` as below.
- `maxSize` is given the most bytes a post may send, as a number whatever size `maxSize` was written as.
- Each is a string or a function; `serverError` is given the error and the action's `ctx` (see [Refused posts](actions.md#refused-posts)). A function runs in the request's locale, so it may word the refusal with `t()`; `serverError` may be async.

#### Proof of work

- `proofOfWork: true` makes each post cost the sender CPU, as ALTCHA does, for a site still getting spam past the others, with no third party, no cookie and no new `csp` source.
- The page carries a challenge for each action its forms post to, the hash of a random salt and a number up to the difficulty, signed as the `minTime` stamp is and bound to the action.
- kay's script solves it in a worker, a same-origin file the browser build ships, from the moment one of those forms takes focus, then sends the solution with the post in an `x-kay-work` header.
- `proofOfWork: 300_000` sets the difficulty, 100,000 by default: the browser hashes half of it on average, some tens of milliseconds on a laptop, more on an old phone.
- `{ difficulty, maxAge: '1h', pretend: true, store }` sets how long a challenge stays good, a day by default.
- `pretend` answers a wrong number or a solution sent twice as `honeypot`'s `pretend` does.
- `store` keeps the solutions already used, each going through once, a `RateStore` as `rateLimit` takes, `sqliteRates(path)` sharing them between the processes of a machine, this process's memory by default.
- A post without a solution, or to a challenge past `maxAge`, another action's or signed before a restart, fails with 422 and `errors['']` carrying a fresh challenge in the same header: an island's call, a script's with no form on the page included, solves it and goes again by itself, the call waiting on it then.
- A form posted without JavaScript sends none and is refused, unless the action sets `minTime` too: a post without JavaScript is then checked by `minTime` alone, so the pair stops no script that waits it out.
- A form posted with `navigation: false` and no island has no script either, nor does one with `data-reload` or a `target`, which the swap leaves to the browser.
- A prerendered page gets a fresh challenge on every visit, as a stamp.
- `site.submit` and `site.call` solve one themselves; a test sending its own `x-kay-work` header, `''` for none, checks the refusal.

#### Proof of work checked in code

- `workChallenge(scope, { difficulty, maxAge })` from `kay/server` signs a challenge bound to `scope` rather than to an action, for code checking it itself, as kayjs-auth's CAPTCHA does: `input(type="hidden" name="proof" data-kay-work={workChallenge('contact')})` posts its solution as the field's value, kay's script solving it from the moment the form takes focus.
- `await verifyWork(input.proof, 'contact', { difficulty, store })` from `kay/server` answers `undefined` once for each solution, else `missing`, `expired` (past `maxAge`, another scope's, signed before a restart, or easier than `difficulty`) or `wrong`. The solutions used are kept in `store`, else the app store's `rates`, else this process's memory.
- The difficulty is signed into the challenge, so a scope asking more refuses one handed out before, the page then signing a harder one; `difficulty` is 100,000 by default and `maxAge` a day.
- A prerendered page gets a fresh challenge in the field on every visit, as a stamp; `site.submit` solves the field unless the test gives its value.

### Body limit

- A request with a body to any route, a library's, an extension's or the jobs page included, sends at most `limits.body`, 1 MB unless kay.config.ts sets another: `limits: { body: '4mb' }`, a size as `budget` takes it (`'800b'`, `'512kb'`, `'1.5mb'`) or a number of bytes.
- An action raises or lowers it for itself, `action(schema, handler, { maxSize: '20mb' })`, and an API module for its routes, `api({ maxSize })`, a size or a function kay reads when it mounts the module (a library reading its own settings).
- A bigger request is refused before anything reads it, from its `Content-Length`, or, sent in chunks without one, as soon as it passes the limit.
- A plain form post goes back to its page with `errors['']` saying the most it may send, an island's call throws `ActionError` with status 413 and that error, and an API route answers 413.
- A route of an extension raises its own through the extension's `maxSize` ([Component libraries](component-libraries.md)); a route you add with `new Elysia().post()` has the app's, and `limits: { byPath: { '/upload': '50mb' } }` in kay.config.ts sets one for a path (the route and what is under it, the `base` left out) without raising the rest. For the path of an `api()` module it wins over the module's `maxSize` (the module's own cors grant stays on the 413), while a route's `detail.maxSize` still wins over both.
- Bun's own cap, 128 MB unless `new Elysia({ serve: { maxRequestBodySize } })` sets another, still holds over any `maxSize`.

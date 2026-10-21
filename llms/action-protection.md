# Protecting actions and limiting requests

- [Actions](actions.md): declaring an action and posting a form to it.
- [Calling actions from islands](actions-from-islands.md): `pending()`, `track()`, optimistic changes and streaming answers.
- [Protecting actions](action-protection.md): cross-site posts, honeypot, minimum time and proof of work; [Rate limits](rate-limits.md) holds every rate limit.

## Common tasks

### Keep scripts from flooding a form

A third argument limits attempts and traps bots, `rateLimit` answering 429 past `max` posts every `window` and `honeypot` failing a form that fills a hidden field:

```kay
--- server
import { s } from 'kay'

export const contact = action(
  s.Object({ message: s.String({ maxLength: 2000 }) }),
  async ({ message }) => message.length,
  { rateLimit: { max: 5, window: '1m' }, honeypot: 'website', minTime: '3s' },
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
- The 403 is `text/plain` and says what it saw: `Cross-site action refused: Origin http://localhost:4701 is not this site (http://127.0.0.1:4701; set or fix site in kay.config.ts if a proxy changes the host)`, or `Sec-Fetch-Site is cross-site and the request has no Origin, not same-origin or none`; the echoed header is stripped of control and bidi characters and cut at 100 without splitting a character, and an empty `Sec-Fetch-Site` with no `Origin` reads `the request sent an empty Sec-Fetch-Site and no Origin`. The same text, `request` for `action`, refuses an api route.
- A post from the host of `site` in kay.config.ts is the site's own, so a proxy that does not pass the browser's `Host` on, and nginx leaves it out unless told `proxy_set_header Host $host`, refuses none.

### Protecting an action

- A third argument protects an action from scripts: `action(schema, handler, { rateLimit: { max: 5, window: '1m' }, honeypot: 'website' })`.
- None of these reaches the handler.

#### Rate limits

- `rateLimit` lets one client post `max` times every `window`, then answers 429 with `Retry-After`; counting, keys and stores are in [Rate limits](rate-limits.md#on-an-action).

#### Honeypot

- `honeypot` names a field a form posting to the action renders by itself as its first child, out of sight, out of the tab order, hidden from screen readers and marked for 1Password, LastPass and Bitwarden to skip, which people leave empty and bots fill in.
- A form post giving it any value, a file included, fails with 422 and `errors.website`.
- It is hidden by a `style` attribute, which a `csp` dropping `style-src 'unsafe-inline'` would leave visible.
- A page writing the field itself as well renders it twice, which still posts empty.
- A form inside an island renders it itself, as its markup is claimed node by node when it hydrates: `div(style="position:absolute;left:-9999px" aria-hidden="true" inert)` around `input(name="website" tabindex="-1" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore)`, and `kay check` takes it as one of the form's fields.
- `honeypot: { field: 'website', pretend: true }` answers a bot filling it in as if its post went through instead, a call with no result and a plain form post going back to its page with `ctx.succeeded(add)` holding `data: undefined`, so the bot learns nothing to adjust.

#### Minimum time

- `minTime: '3s'` refuses a form posted sooner than that after its page rendered, with 422 and `errors['']`.
- A form posting to the action renders a hidden `kay_since` field by itself, a stamp of when it rendered bound to the action and signed with a key derived from the session's secret, else from `secret` in kay.config.ts or `KAY_SECRET` (at least 32 random characters, so an app without sessions needs no `session()` for one), else from the preview `secret`, else a key of the process, which a restart changes and a production server warns of once, naming where the secret goes; a test server never warns.
- A plain form post whose stamp is missing, forged, another action's or older than `maxAge`, a day by default, fails the same way, and the page it answers keeps the stamp the form rendered with, so the visitor does not wait again from zero.
- A prerendered page holding such a form is still rendered once: the server signs a fresh stamp into it on every visit, as it splices in an inline server island, so the page goes out gzipped rather than in brotli and kept by no cache.
- `minTime: { after: '3s', maxAge: '1h', pretend: true }` answers a post sent too soon as `honeypot`'s `pretend` does.
- A form inside an island renders no stamp, so a call from kay's script without one goes through, a stamp it sends still checked.
- `minTime: { after: '3s', plain: true }` checks only a form the browser posts itself, without kay's script: the page swap's post and an island's call go through, for a form whose script already proves something, such as a `data-kay-work` field below: the header marking the swap's post proves nothing, so a script sending it skips `minTime`.
- `site.submit` from a `Visit` sends its form's stamp, and `setSystemTime` from `bun:test` moves the clock past `minTime`.

#### Offering an action to agents

- `tool` on the third argument offers the action as an MCP tool when `mcp: true` is set in kay.config.ts: `tool: true`, `tool: 'Create a note'` (its description) or `tool: { name: 'create_note', description: 'Create a note' }`. Without it an action is never offered.
- The tool takes the action's schema as its input and runs the action as a call would, its guards, `rateLimit`, body limit and `ctx.locals` included; `honeypot`, `minTime` and `proofOfWork` are skipped. An action with a file in its schema is not offered.
- `kay check` warns (`unguarded-tool`) of such an action with one of those three and no guard; a guard or a `rateLimit` keeps it in hand. See [API routes](api-routes.md#mcp).

#### Refusal messages

- The refusals of these limits, and the one for a post over `bodyLimit`, read in English unless the site words them once for every action under `kay.protection.*` and `kay.action.*` in its catalogs ([Locales](locales.md#texts-from-kay-and-its-libraries)), or `messages` gives an action's own, as a schema's `error` does for a field: `` messages: { honeypot: 'Laissez ce champ vide', minTime: reason => reason === 'early' ? 'Un instant, puis renvoyez-le' : 'Ce formulaire a expiré, renvoyez-le', rateLimit: wait => `Réessayez dans ${wait} s`, bodyLimit: bytes => `${bytes} octets au plus` } ``.
- `rateLimit` is given the seconds to wait.
- `minTime` is given `early` for a post sent too soon or `expired` for a stamp missing, forged or past `maxAge`, as a page from before a restart sends.
- `proofOfWork` is given `missing`, `expired` or `wrong` as below.
- `bodyLimit` is given the most bytes a post may send, as a number whatever size `bodyLimit` was written as.
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
- `await verifyWork(input.proof, 'contact', { difficulty, store })` from `kay/server` answers `undefined` once for each solution, else `missing`, `expired` (past `maxAge`, another scope's, signed before a restart, or easier than `difficulty`) or `wrong`.
- The difficulty is signed into the challenge, so a scope asking more refuses one handed out before, the page then signing a harder one; `difficulty` is 100,000 by default and `maxAge` a day.
- A prerendered page gets a fresh challenge in the field on every visit, as a stamp; `site.submit` solves the field unless the test gives its value.

### Body limit

- A request to an action or an API route sends at most `bodyLimit`, 1 MB unless kay.config.ts sets another: `bodyLimit: '4mb'`, a size as `budget` takes it (`'800b'`, `'512kb'`, `'1.5mb'`) or a number of bytes.
- An action raises or lowers it for itself, `action(schema, handler, { bodyLimit: '20mb' })`, and an API module for its routes, `api({ bodyLimit })`, a size or a function kay reads when it mounts the module (a library reading its own settings).
- A bigger request is refused before anything reads it, from its `Content-Length`, or, sent in chunks without one, as soon as it passes the limit.
- A plain form post goes back to its page with `errors['']` saying the most it may send, an island's call throws `ActionError` with status 413 and that error, and an API route answers 413.
- Bun's own cap, 128 MB unless `new Elysia({ serve: { maxRequestBodySize } })` sets another, holds whatever `bodyLimit` says, and it alone limits the app's own routes.

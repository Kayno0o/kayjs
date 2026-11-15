# Events and names

kay and its libraries tell an app what happened with DOM events, and keep what a browser remembers under names that follow one rule each. Names are frozen after 2.0.

## Common tasks

- Hear what kay did from an island: its function hook (the table below); from a plain script: `document.addEventListener('kay:renew', ...)`. Tell a component something: `document.dispatchEvent(new CustomEvent('kai:chat-send', { detail: { text } }))`.
- Move an app off the old names: `kay upgrade`, or `kay check --fix`.

## Reference

### Events

- A public event is `<lib>:<verb>` (`kay:`, `kai:` for kayjs-ai, `kui:` for kayjs-ui) fired on `document`, with an object `detail`. A plain script (an analytics tag, a lightbox) listens with `document.addEventListener('kay:renew', ...)`, an island with the function hook of the table below, which ends with the island and hands an object of its own where the event hands `detail`; `listen(() => document, 'kay:navigate', ...)` in an island is `deprecated-island-events`, and `listen(() => document, 'kay:renew', ...)` stays for the events with no hook. An event an app sends to a component is dispatched on `document` too, `new CustomEvent('kai:chat-send', { detail: { text } })`.
- An event about one element (`kay:action-*` on a form, `kui:hold-defaults` on a form) bubbles, so `document` hears it as well.

| Event | Fires | `detail` | Hook of an island |
| --- | --- | --- | --- |
| `kay:navigate-start` | a page swap begins | `{ url }` | `navigation.onStart(({ url }) => ...)` |
| `kay:navigate` | the new page is in place and its islands hydrate | `{ url }` | `navigation.onNavigate(({ url }) => ...)` |
| `kay:navigate-error` | the swap gave up, the browser loads the page in full | `{ url, error }` | `navigation.onError(({ url, error }) => ...)`, `error` an `ApiError` |
| `kay:navigate-stall` | a streamed page sent nothing for `pageTimeout` | `{ url }` | `navigation.onStall(({ url }) => ...)` |
| `kay:consent` | the visitor answered the analytics notice | `{ consent }` | the `consent` signal: `effect(() => consent())` |
| `kay:action-start` | a `form(action)` posting in place begins, on the form | `{ action, data }` | `add.onStart(({ input }) => ...)` |
| `kay:action-success` | it went through | `{ action, data }` | `add.onData(({ input }) => ...)` |
| `kay:action-error` | it did not | `{ action, status, errors, data }` | `add.onError(({ error, input }) => ...)`, `error` an `ApiError` with `status` and `errors` |
| `kay:renew` | the page asked for new live proofs | `{}` | none: `listen(() => document, 'kay:renew', ...)` |
| `kay:install` | the browser's install offer appeared or was used | `{ available }` | `installPrompt.available()` |
| `beforeNavigate` (no event) | a link, `navigate()` or Back is about to leave the page | | `navigation.onBeforeNavigate(({ url, from }) => ...)`, which `guardLeave(dirty)` presets |
| `kay:dev-built` | `kay dev` rebuilt after a change | `{ changed, ms, ... }` |
| `kay:dev-types` | the type check ended | `{ problems }`, the reports as strings |
| `kai:chat-open` | sent to open a `ChatLauncher` | `{}` |
| `kai:chat-send`, `kai:chat-draft` | sent to a `ChatLauncher`, or to a `.kai-chat` element, to send a message or fill the field | `{ text }` |
| `kai:chat-new` | a `ChatLauncher` tells its chat to start over, on the `.kai-chat` element | `{}` |
| `kui:hold-defaults` | a `SaveForm` saved: the controls that keep their default in a signal push what they hold | `{ adopt }`, an array a control pushes a function to |

### Cookies

- A cookie kay or a library sets is `kay_<name>` in snake case (`kay_locale`, `kay_editor_session`), `__Host-kay_session` over https for the session. One that scripts must read is marked so in [privacy](privacy.md), which lists every cookie.
- Exceptions kept because the old name is a person's data a rename would drop: kayjs-ui's `theme` and `ksteps_<name>`.

### Browser storage

- A `localStorage` or `sessionStorage` key is `<lib>:<name>`, `<lib>` being `kay`, `kai`, `kui` or `kcms`: `kay:reloaded`, `kay:push-posted`, `kay:editor-refused`, `kay:dev`, `kai:chat-conversation:<url>`, `kcms:editor` (the dock layout), `kcms:draft:<id>`. A key renamed in 1.99 is read once under its old name and moved when it holds something a person would lose (the push record, the chat's shown conversation, the editor's dock layout); the others were disposable and start again.
- Exceptions: the IndexedDB database `kay-local` (unsent writes are the person's data), the cache `kay-w<version>` (named by the build) and a key an app names itself with `persisted`.

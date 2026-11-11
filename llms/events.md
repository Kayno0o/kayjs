# Events and names

kay and its libraries tell an app what happened with DOM events, and keep what a browser remembers under names that follow one rule each. Names are frozen after 2.0.

## Common tasks

- Hear what kay did: `document.addEventListener('kay:renew', ...)`; tell a component something: `document.dispatchEvent(new CustomEvent('kai:chat-send', { detail: { text } }))`.
- Move an app off the old names: `kay upgrade`, or `kay check --fix`.

## Reference

### Events

- A public event is `<lib>:<verb>` (`kay:`, `kai:` for kayjs-ai, `kui:` for kayjs-ui) fired on `document`, with an object `detail`. Listen with `document.addEventListener('kay:renew', ...)`, or `listen(() => document, 'kay:renew', ...)` in an island. An event an app sends to a component is dispatched on `document` too, `new CustomEvent('kai:chat-send', { detail: { text } })`.
- An event about one element (`kay:action-*` on a form, `kui:hold-defaults` on a form) bubbles, so `document` hears it as well.
- The names before 1.99 (`kay-renew`, `kay-dev-built`, `kay-dev-types`, `kai-chat-*`, `kui-hold-defaults`, and `kay:install` on the window) fire too, on their old target with their old `detail`, and the chat hears its old ones, until 1.103. `deprecated-event-names` finds a listener or a dispatch of them that `kay check` can read, and `kay upgrade` writes the new form where nothing else changes.

| Event | Fires | `detail` | Before 1.99, until 1.103 |
| --- | --- | --- | --- |
| `kay:navigate-start` | a page swap begins | `{ url }` | |
| `kay:navigate` | the new page is in place and its islands hydrate | `{ url }` | |
| `kay:navigate-error` | the swap gave up, the browser loads the page in full | `{ url, error }` | |
| `kay:navigate-stall` | a streamed page sent nothing for `pageTimeout` | `{ url }` | |
| `kay:consent` | the visitor answered the analytics notice | `{ consent }` | |
| `kay:action-start`, `kay:action-success`, `kay:action-error` | a `form(action)` posting in place, on the form | `{ action, data }`, `{ action }`, `{ action, status, errors }` | |
| `kay:renew` | the page asked for new live proofs | `{}` | `kay-renew` on the window, no detail |
| `kay:install` | the browser's install offer appeared or was used | `{ available }` | `kay:install` on the window, no detail |
| `kay:dev-built` | `kay dev` rebuilt after a change | `{ changed, ms, ... }` | `kay-dev-built` on the window, the JSON as a string |
| `kay:dev-types` | the type check ended | `{ problems }`, the reports as strings | `kay-dev-types` on the window, the JSON as a string |
| `kai:chat-open` | sent to open a `ChatLauncher` | `{}` | `kai-chat-open` on the window |
| `kai:chat-send`, `kai:chat-draft` | sent to a `ChatLauncher`, or to a `.kai-chat` element, to send a message or fill the field | `{ text }` | `kai-chat-send`, `kai-chat-draft` on the window, `detail` the text |
| `kai:chat-new` | a `ChatLauncher` tells its chat to start over, on the `.kai-chat` element | `{}` | `kai-chat-new` on the `.kai-chat` element, still heard |
| `kui:hold-defaults` | a `SaveForm` saved: the controls that keep their default in a signal push what they hold | `{ adopt }`, an array a control pushes a function to | `kui-hold-defaults` on the form, `detail` the array |

### Cookies

- A cookie kay or a library sets is `kay_<name>` in snake case (`kay_locale`, `kay_editor_session`), `__Host-kay_session` over https for the session. One that scripts must read is marked so in [privacy](privacy.md), which lists every cookie.
- Exceptions kept because the old name is a person's data a rename would drop: kayjs-ui's `theme` and `ksteps_<name>`.

### Browser storage

- A `localStorage` or `sessionStorage` key is `<lib>:<name>`, `<lib>` being `kay`, `kai`, `kui` or `kcms`: `kay:reloaded`, `kay:push-posted`, `kay:editor-refused`, `kay:dev`, `kai:chat-conversation:<url>`, `kcms:editor` (the dock layout), `kcms:draft:<id>`. A key renamed in 1.99 is read once under its old name and moved when it holds something a person would lose (the push record, the chat's shown conversation, the editor's dock layout); the others were disposable and start again.
- Exceptions: the IndexedDB database `kay-local` (unsent writes are the person's data), the cache `kay-w<version>` (named by the build) and a key an app names itself with `persisted`.

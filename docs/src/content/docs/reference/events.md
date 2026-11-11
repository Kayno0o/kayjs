---
title: Events and names
order: 6
description: The DOM events kay and its libraries fire, and the names of their cookies and storage keys.
---
A public event is named `<lib>:<verb>`, `kay:` for kay, `kai:` for kayjs-ai and `kui:` for kayjs-ui, and fires on `document` with an object as its `detail`. An event about one element, such as `kay:action-start` on a form, bubbles, so `document` hears it too.

```ts
document.addEventListener('kay:renew', () => refreshMyWidget())
document.dispatchEvent(new CustomEvent('kai:chat-send', { detail: { text: 'Hello' } }))
```

| Event | Fires | `detail` |
| --- | --- | --- |
| `kay:navigate-start`, `kay:navigate` | a page swap begins, and the new page is in place | `{ url }` |
| `kay:navigate-error` | the swap gave up and the browser loads the page in full | `{ url, error }` |
| `kay:navigate-stall` | a streamed page sent nothing for `pageTimeout` | `{ url }` |
| `kay:consent` | the visitor answered the analytics notice | `{ consent }` |
| `kay:action-start`, `kay:action-success`, `kay:action-error` | a form posting in place, on the form | `{ action, data }`, `{ action }`, `{ action, status, errors }` |
| `kay:renew` | the page asked for new live proofs | `{}` |
| `kay:install` | the browser's install offer appeared or was used | `{ available }` |
| `kay:dev-built`, `kay:dev-types` | `kay dev` rebuilt, and the type check ended | `{ changed, ms }`, `{ problems }` |
| `kai:chat-open`, `kai:chat-send`, `kai:chat-draft` | you send them to a `ChatLauncher` | `{}`, `{ text }`, `{ text }` |
| `kui:hold-defaults` | a SaveForm saved, on the form | `{ adopt }` |

Until 1.98 some of these had dashed names on `window`: `kay-renew`, `kay-dev-built`, `kay-dev-types` and the chat's `kai-chat-open`, `kai-chat-send` and `kai-chat-draft`, with no `detail` or a bare string. They are still fired, and the chat still hears them, until 1.103. `kay check` reports a listener or a dispatch of them in a script, and `kay upgrade` writes the new form where nothing else changes.

## Cookies and storage keys

kay's cookies are `kay_<name>`, such as `kay_locale`, and the keys in `localStorage` and `sessionStorage` are `<lib>:<name>`, such as `kay:reloaded` or `kcms:draft:<id>`.

A key renamed in 1.99 is moved from its old name when it held something a visitor would lose, the chat's shown conversation, the editor's dock layout and the push record. kayjs-ui's `theme` and `ksteps_<name>` cookies, the `kay-local` IndexedDB database that holds unsent writes keep their names. The [privacy guide](/guides/privacy) lists every one.

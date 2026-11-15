---
title: Events and names
order: 6
description: The DOM events kay and its libraries fire, and the names of their cookies and storage keys.
---
A public event is named `<lib>:<verb>`, `kay:` for kay, `kai:` for kayjs-ai and `kui:` for kayjs-ui, and fires on `document` with an object as its `detail`. An event about one element, such as `kay:action-start` on a form, bubbles, so `document` hears it too.

A plain script, an analytics tag or a lightbox, listens to them. An island has a function hook for each one instead, in the last column of the table below: it hands an object of its own, ends with the island and returns a function that removes it sooner.

```ts
document.addEventListener('kay:renew', () => refreshMyWidget())
document.dispatchEvent(new CustomEvent('kai:chat-send', { detail: { text: 'Hello' } }))
```

| Event | Fires | `detail` | Hook of an island |
| --- | --- | --- | --- |
| `kay:navigate-start` | a page swap begins | `{ url }` | `navigation.onStart` |
| `kay:navigate` | the new page is in place | `{ url }` | `navigation.onNavigate` |
| `kay:navigate-error` | the swap gave up and the browser loads the page in full | `{ url, error }` | `navigation.onError` |
| `kay:navigate-stall` | a streamed page sent nothing for `pageTimeout` | `{ url }` | `navigation.onStall` |
| `kay:consent` | the visitor answered the analytics notice | `{ consent }` | the `consent` signal |
| `kay:action-start` | a form posting in place begins, on the form | `{ action, data }` | `add.onStart` |
| `kay:action-success` | the post went through | `{ action, data }` | `add.onData` |
| `kay:action-error` | the post did not | `{ action, status, errors, data }` | `add.onError` |
| `kay:renew` | the page asked for new live proofs | `{}` | none |
| `kay:install` | the browser's install offer appeared or was used | `{ available }` | `installPrompt.available()` |
| `kay:dev-built`, `kay:dev-types` | `kay dev` rebuilt, and the type check ended | `{ changed, ms }`, `{ problems }` | none |
| `kai:chat-open`, `kai:chat-send`, `kai:chat-draft` | you send them to a `ChatLauncher` | `{}`, `{ text }`, `{ text }` | none |
| `kui:hold-defaults` | a SaveForm saved, on the form | `{ adopt }` | none |

Leaving a page has no event: `navigation.onBeforeNavigate` is asked before a link, `navigate()` or Back leaves it, and `guardLeave(dirty)` is its preset for unsaved changes.

Before 1.99 some of these had dashed names on `window`: `kay-renew`, `kay-dev-built`, `kay-dev-types` and the chat's `kai-chat-open`, `kai-chat-send` and `kai-chat-draft`, with no `detail` or a bare string. 1.103 dropped them: nothing fires or hears them now, so a listener or a dispatch under the old name does nothing until it is written `<lib>:<verb>` on `document`.

## Cookies and storage keys

kay's cookies are `kay_<name>`, such as `kay_locale`, and the keys in `localStorage` and `sessionStorage` are `<lib>:<name>`, such as `kay:reloaded` or `kcms:draft:<id>`.

A key renamed in 1.99 is moved from its old name when it held something a visitor would lose, the chat's shown conversation, the editor's dock layout and the push record. kayjs-ui's `theme` and `ksteps_<name>` cookies, the `kay-local` IndexedDB database that holds unsent writes keep their names. The [privacy guide](/guides/privacy) lists every one.

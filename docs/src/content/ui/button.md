---
description: A button or a link styled as one, with an optional icon and a busy state.
---

<Demo name="button/basic" />

## Variants

`variant` is `default`, `accent` for the main action or `danger` for a destructive one.

<Demo name="button/variants" />

## With an icon

`icon` draws one of the library's icons before the label.

<Demo name="button/icon" />

## Busy

Return a promise from `onClick` and the button swaps its icon for a spinner, marks itself `aria-busy` and disables itself until the promise settles. Only that button is held, however many share an action. A submit button does the same while its form's `onSubmit` returns a promise.

Pass `busy` yourself to decide instead: it has the last word, and it only shows the spinner without disabling the button.

<Demo name="button/busy" />

## As a link

Given an `href`, the button renders an `a` that looks like one, for an action that goes to another page.

<Demo name="button/link" />

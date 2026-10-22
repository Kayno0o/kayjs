---
description: A button or a link styled as one, with an optional icon and a busy state.
---

<Demo name="button/basic" />

## Variants

`variant` names the form: `solid` (the default), `ghost` or `inline`. `tone` names the meaning: `neutral` (the default), `accent` for the main action, `success` for a confirming one or `danger` for a destructive one. `size` goes from `xs` to `lg`, `md` by default.


<Demo name="button/variants" />

## With an icon

`icon` draws one of the library's icons before the label.

<Demo name="button/icon" />

## Busy

Return a promise from `onClick` and the button swaps its icon for a spinner, marks itself `aria-busy` and disables itself until the promise settles. Only that button is held, however many share an action. A submit button shows the spinner and ignores clicks the same way, but is not disabled, so it still submits its form, while its `onClick` or its form's `onSubmit` returns a promise.

Pass `busy` yourself to decide instead: it has the last word, and it only shows the spinner without disabling the button.

<Demo name="button/busy" />

A button that draws its own progress, such as an overlay in its slot, passes `spinner={false}`: the icon and label stay, and the button is still busy and disabled until its promise settles. Passing `busy={false}` instead would switch the automatic disabling off with it.

## Toggle buttons

`pressed` makes a button a toggle: it writes `aria-pressed` and draws an accent keyline while it is `true`, so a grid of options or an on/off switch needs no CSS and tells assistive technology which is on. A button given no `pressed` is no toggle and writes no `aria-pressed`.

<Demo name="button/pressed" />

## As a link

Given an `href`, the button renders an `a` that looks like one, for an action that goes to another page.

<Demo name="button/link" />

## Type and disclosure

`type` is `button` by default, so a button in a form does not submit it. Set `type="submit"` or `"reset"` for the form's own buttons.

`expanded` says whether the disclosure the button opens is showing, for a popover or a panel it toggles.

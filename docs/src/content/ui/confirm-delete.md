---
description: A delete trigger that asks for confirmation in a dialog before running the deletion.
---

<Demo name="confirm-delete/basic" />

`onConfirm` does the deletion. The dialog keeps its buttons disabled until the returned promise settles, then closes.

## A labelled button

`trigger="button"` draws a labelled danger button instead of the icon, and `label` renames it for a delete the reader knows by another name.

<Demo name="confirm-delete/button" />

## When it fails

If `onConfirm` throws, the dialog stays open and `failure` is toasted.

`success` is toasted once `onConfirm` went through.

<Demo name="confirm-delete/failure" />

## A confirm that is not a deletion

`tone="neutral"` asks before an action that deletes nothing, such as a save with a consequence. Its buttons take the accent look, and the dialog's title and confirm button say the `label`. `title`, `confirmLabel` and `pendingLabel` still replace any of them.

<Demo name="confirm-delete/neutral" />

## Inline

`ask="inline"` asks in place instead of in a dialog, for a row of a list: a click arms the trigger into a danger button that deletes and one that cancels, and moves the focus onto the first. `message` names the pair for screen readers and shows as the danger button's tooltip. Escape or the cancel button puts the trigger back, focused.

<Demo name="confirm-delete/inline" />

## Refusals of the handler

A handler refusing with `ctx.fail(400, { error: 'Still in use' })` is a failure of `onConfirm`. Give `refused` a function from that data to a message, and it is toasted in place of `failure`. `failure` stays for an answer of `undefined` and for any other error.

## Refusals of an API route

A deletion made with `call()` throws an `ApiError` when the route refuses. It is read like a refusal of a handler: the dialog stays open and the words the route answered with are toasted for a 4xx when they read as a message (a proxy's HTML page or a bare code does not), or `refused` reads its JSON `answer`. A call that got no answer at all (status 0) and a 5xx toast `failure`.

## Look and cancel label

`size` is `xs`, `sm`, `md` or `lg` for the icon trigger, and sizes the cancel button too when asking inline. `variant` is `solid`, `ghost` or `inline`. `cancelLabel` words the cancel button, `Cancel` by default.

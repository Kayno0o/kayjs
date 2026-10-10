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

<Demo name="confirm-delete/failure" />

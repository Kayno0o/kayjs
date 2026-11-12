---
description: Shows the dialog that answers confirm(), asking a yes or no question from any handler.
---

<Demo name="confirm-host/basic" />

`await confirm({ message })` resolves `true` once the reader confirms and `false` on cancel, Escape or a click outside. `ConfirmHost` is the dialog that asks. `ui()` renders one on every page, so an app writes nothing; render `ConfirmHost` in a layout to place it yourself, and it wins over the extension's. This page already renders one.

Without any host on the page the browser's own `confirm` asks, and on the server `confirm()` answers `false`. Questions asked together are shown one after the other.

## Words and tone

`title`, `confirmLabel` and `cancelLabel` replace the words. `tone="danger"` is the delete preset, which [ConfirmDelete](/ui/confirm-delete) is built on: `Confirm Deletion`, `Delete` and a danger confirm button. Any other tone colours the confirm button, `neutral` giving the accent look.

## Keyboard and screen readers

The dialog is an `alertdialog` described by its message. The focus starts on the cancel button, so a stray Enter cancels, Escape cancels, and the focus goes back to what held it when the dialog closes.

## Attributes

Other attributes go on the dialog, as on [Dialog](/ui/dialog). `fallback` is for an extension's own host only.

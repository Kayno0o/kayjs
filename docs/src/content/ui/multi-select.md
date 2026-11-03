---
description: A trigger summing up what is picked, opening a popover of checkboxes.
---

<Demo name="multi-select/basic" />

`onChange` hands back the picked values in the options' order, typed like the options' values, so a union of strings needs no cast. An option may carry an `icon`, drawn before its label, and be `disabled`: it cannot be flipped and stays as it is under All and None.

## Search and forms

Past eight options, or with `search`, the panel opens on a search box filtering the options. `placeholder` is what the trigger reads while nothing is picked, and `selectedLabel(count)` words the count once several are. Screen readers hear the trigger as its label and that summary, a count described by the labels it stands for. `name` submits each picked value as a hidden field, so the control works inside a plain form.

<Demo name="multi-select/search" />

## Keyboard

The trigger opens the panel on its search box, or its first checkbox. ArrowDown reaches the options, where the arrows, Home and End move between them and Space ticks one. Tab walks the search box and the All and None buttons, and closes the panel once it moves past them; Escape closes it with focus back on the trigger.

## Props and labels

`disabled` stops the trigger opening. `placement` is where the panel opens, `bottom-start` by default, and `id` is the panel's id, unique on the page. kay draws one when you give none.

`searchLabel` is the search box's placeholder, and with `label` after it, its name for screen readers. `allLabel` and `noneLabel` word the buttons picking every option shown and none of them. `emptyLabel` is what a search matching none says. They read `Search`, `All`, `None` and `No match` by default.

## Opened by the app

`open` shows the panel when your code sets it, and `onOpenChange(open)` is called with the new state whenever the panel shows or hides: the trigger, a click outside, Escape or focus leaving it. When you drive `open`, set your own value back in `onOpenChange`, or a click outside would leave it saying "open".

## Options from an action

`options` can be a function answering the options for the text typed, such as an action or a wrapped API call: `options={({ q }) => people(q)}`. It is asked when the panel opens and after a pause in typing, and the latest answer wins.

The status line says `loadingLabel` while it waits and `failureLabel` when it fails, and `minLength` holds the ask back until enough is typed. What is picked keeps its label when a later search no longer lists it. For a value picked before any answer lists it, give its label in `valueLabels`. `onLoad(options, query)` and `onError(error, query)` follow each answer.

## Drawing an option

`@option(option)` draws each option in place of its label and icon, as in Combobox. The checkbox stays, named by the option's `label`.


## Size and invalid

`size` is `sm`, `md` or `lg`, `md` by default, and changes the padding and the type of the button. `invalid` draws the line and the focus ring in the danger colour and sets `aria-invalid="true"`, for a refusal the page knows of. A FormField marks its control itself while it shows a message.

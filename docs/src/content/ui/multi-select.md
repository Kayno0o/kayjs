---
description: A trigger summing up what is picked, opening a popover of checkboxes.
---

<Demo name="multi-select/basic" />

`onChange` hands back the picked values in the options' order, typed like the options' values, so a union of strings needs no cast.

## Search and forms

Past eight options, or with `search`, the panel opens on a search box filtering the options. `placeholder` is what the trigger reads while nothing is picked, and `selectedLabel(count)` words the count once several are. Screen readers hear the trigger as its label and that summary, a count described by the labels it stands for. `name` submits each picked value as a hidden field, so the control works inside a plain form.

<Demo name="multi-select/search" />

## Keyboard

The trigger opens the panel on its search box, or its first checkbox. ArrowDown reaches the options, where the arrows, Home and End move between them and Space ticks one. Tab walks the search box and the All and None buttons, and closes the panel once it moves past them; Escape closes it with focus back on the trigger.

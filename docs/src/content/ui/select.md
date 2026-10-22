---
description: A native select box for a list of options, with an optional empty choice.
---

<Demo name="select/basic" />

An option is `{ value, label, disabled? }`; a `disabled` one cannot be picked. A native option draws no icon, so unlike the other groups' options it has none.

## Typed values

`value` and `onChange` take the type of the options' values. A union of strings stays that union, and a number option hands back a number. With `emptyOption`, they take the empty string too, so hold the value as `Kind | ''`.

```kay
Select(value={kind()} options={KINDS} onChange={kind.set} emptyOption="Any kind" aria-label="Kind")
```

## Loading options

When the options come from a request, set `busy` to show a disabled row in their place, and `loadingLabel` to word it. The chosen `value` stays selected once the options arrive.

<Demo name="select/loading" />

## Submitting on pick

Set `submit` on a Select inside a form to submit that form once an option is picked, after `onChange`. A GET filter form then needs no ref to itself.

A pick with the mouse submits at once. Some browsers report a change on every arrow key, so a pick with the keyboard waits for Enter, or for the select to lose focus, and a person moving through the options does not post once per key.

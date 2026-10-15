---
description: A native select box for a list of options, with an optional empty choice.
---

<Demo name="select/basic" />

## Typed values

`value` and `onChange` take the type of the options' values. A union of strings stays that union, and a number option hands back a number. With `emptyOption`, they take the empty string too, so hold the value as `Kind | ''`.

```kay
Select(value={kind()} options={KINDS} onChange={kind.set} emptyOption="Any kind" aria-label="Kind")
```

## Loading options

When the options come from a request, set `loading` to show a disabled row in their place, and `loadingLabel` to word it. The chosen `value` stays selected once the options arrive.

<Demo name="select/loading" />

---
description: A text field that reports each keystroke and the committed value.
---

<Demo name="text-input/basic" />

`onInput` is called on each keystroke and `onChange` once the value is committed, on blur or Enter.

## Types

`type` picks the kind of field, such as `email` or `number`. A number box hands back a number, or `null` once emptied. Its `value` takes a number, `null` or a string. A number box mid-word reports nothing until it parses, so a half-typed figure never reads as a cleared field. Other attributes such as `placeholder` and `min` pass through to the input.

<Demo name="text-input/types" />

---
description: Text with a tooltip that the keyboard reaches as well as the pointer.
---

<Demo name="tooltip/basic" />

`Tooltip` renders a `span` with `data-tooltip` set to `text` and `tabindex="0"`, so the keyboard lands on it and [TooltipHost](/ui/tooltip-host) shows the tooltip there as it does under the pointer. Render one `TooltipHost` in the root layout. Without it nothing shows.

`placement` says where the tooltip sits, as a CSS `position-area`: `top` by default, or `bottom`, `left`, `right`. Any other attribute of a `span` goes on the element.

A button with a reason it is off needs no wrapper: a [Button](/ui/button) that is `disabled` and has a `data-tooltip` stays reachable.

A `span(data-tooltip="..." tabindex="0")` written by hand in a file that imports kayjs-ui is reported as `hand-tooltip`, and `kay check --fix` rewrites it to `Tooltip` with its import.

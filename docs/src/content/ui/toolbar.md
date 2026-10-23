---
description: A row of buttons acting on the same thing, named as a toolbar.
---

<Demo name="toolbar/basic" />

`label` names the toolbar for screen readers. `caption` is a line of text before the buttons, for the eyes only, such as what they act on.

## Floating

`floating` frames the buttons in a card fixed at a point of the window. The app places it with `style` (`left` and `top`) and layers it with `z-index`. A lone button sets `role="group"`, as it is no toolbar.

<Demo name="toolbar/floating" />

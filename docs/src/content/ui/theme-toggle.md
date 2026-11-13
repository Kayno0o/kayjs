---
description: A switch between light, dark and the system's scheme that the server knows from the first render.
---

<Demo name="theme-toggle/basic" />

The choice is kept in the `theme` cookie and put on `html` as `data-theme` as it is picked, so the theme switches at once; `system` takes the attribute off and the stylesheet follows `prefers-color-scheme` again.

## No flash

The server reads the cookie, so a layout writes the visitor's scheme into the first response:

```kay
---
import { scheme } from '@kayjs/ui'
---
head
  html(data-theme={scheme()})
```

`scheme()` is `'light'`, `'dark'`, or `undefined` while the visitor follows the system: no attribute is written and the stylesheet follows the system. It reads the cookie only, so with a `value` of your own (an account preference) the layout writes that value into `html(data-theme=...)` itself. A page prerendered at build renders the default and the toggle corrects it as it hydrates, so a site that wants no flash renders its pages per request.

## Choices

`modes` lists the choices and their order. Each is a mode, or `{ value, label?, icon? }` to word or draw it yourself:

```kay
ThemeToggle(modes={['light', { value: 'dark', label: 'Night' }]} label="Appearance")
```

`showLabel` writes `label` above the group, and `@option(option)` draws each option in place of its label, as on [Segmented](/ui/segmented). `class` is a string for the group, or `class={{ root: { option: 'p-2' } }}` for Segmented's parts.

## Holding the choice yourself

`value` makes the app the holder, such as a saved preference of a signed-in visitor. The toggle follows it and writes no cookie. `onChange(mode, option)` hears each pick, and may return a promise as on Segmented: the toggle is busy until it settles, and a pick that resolves to `false` or rejects is put back and not kept.

`cookie="appearance"` keeps the choice under another name; the layout must then call `scheme('appearance')`, or it reads the default cookie.

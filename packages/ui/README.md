# kayjs-ui

kay components for the user's sites, ported from `@kaynooo/svelte` and `@kaynooo/solidjs`: buttons and icons, toasts, dialogs and a form dialog calling a page's action, a sortable table, switches, inputs, cards, badges, popovers and tooltips. They are `.kay` sources the app compiles as its own, styled by `theme.css` classes the app restyles from its own stylesheet.

```sh
bun add @kaynooo/kayjs-ui @iconify-json/tabler
```

```css
@import 'tailwindcss';
@import '@kaynooo/kayjs-ui/theme.css';
@source '../.kay/classes.txt';
```

```kay
---
import Button from '@kaynooo/kayjs-ui/button.kay'
---
Button(label="Save" variant="accent" icon="plus")
```

Tests: `bun run test` runs the server tests, then the DOM tests on happy-dom, against the fixture app in `tests/fixture`.

The full reference, written for people and coding agents alike, is [llms.txt](llms.txt).

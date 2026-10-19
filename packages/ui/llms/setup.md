# kayjs-ui: Setup, settings and testing

## Setup

kayjs-ui is published as `@kaynooo/kayjs-ui` to `https://git.kaynooo.fr/api/packages/kaynooo/npm/`, beside kay. kay, Tailwind v4 and `@iconify-json/tabler` are peer dependencies. It is released with kay at its version and peers on kay's minor: the app installs the one matching its kay and moves them together.

```sh
bun add @kaynooo/kayjs-ui @iconify-json/tabler
```

`src/app.css`, imported by the root `_layout.kay`, imports the theme right after Tailwind. kay collects the classes of the library's templates along with the app's own, so no `@source` line has to point into `node_modules`:

```css
@import 'tailwindcss';
@import '@kaynooo/kayjs-ui/theme.css';
@source '../.kay/classes.txt';

@theme {
  --color-kui-accent: light-dark(#3b6fd4, #7aa2f7);
}
```

kay leaves out the theme's rules for the `kui-` classes no file of the app or component it renders writes whole, so an app ships the CSS of the components it uses; a class put together at runtime, or written only in a CMS body, is kept by writing it whole in any file of the app, for instance in a comment in `app.css` (see Using a component library in kay's `llms/component-libraries.md`).

The theme's tokens are `@theme default`, so the app's `@theme` overrides any of them wherever it sits. Each colour is `--color-kui-<name>`, used as `bg-kui-<name>` and the like, and holds `light-dark(light, dark)`:

- Surfaces, deepest first: `mantle`, `canvas`, `surface0`, `surface1`.
- Hairlines: `surface2` and `overlay0`.
- Text: `text`, `overlay1` (the faintest), `subtext0` and `muted`.
- State: `accent`, `accent-hi` (its hover), `on-accent` (text on it), `success`, `warning`, `info` and `error`.
- Fills: `fill-hover`, `fill-danger` and `row-hover`.
- Fields: `field-border`, the solid border of a text field, which buttons, Toggle tracks, carousel dots and empty Rating stars draw too, at 3:1 on every surface, so an app changing its surfaces sets it to match; and `field-focus`, the border of a focused text field, `accent` unless set.
- Stamps (`Badge(stamp)`): `stamp` (its ink and hairline), `stamp-fill` and `stamp-fill-hover` (its ground while a `.group` holding it is hovered).
- Chart series: `chart-1` to `chart-6`.

A few components take tokens for their box and type, for a skin restyling them without redeclaring their selector:

- Badge: `--kui-border-badge`, `--spacing-kui-badge-x`, `--spacing-kui-badge-y`, `--text-kui-badge`, `--tracking-kui-badge`, `--kui-badge-case` (`none` or `uppercase`) and `--kui-badge-font`, the text's own unless set, such as to `var(--font-mono)`, and `--kui-badge-solid-text`, the text colour of a `solid` badge (`--color-kui-on-accent` unless set); `--kui-border-stamp` for a stamp.
- Text fields, `kui-field-input` and a FormField's controls: `--spacing-kui-field-x` and `--spacing-kui-field-y` for the inset, `--kui-field-focus-shadow` for a shadow while focused, `none` by default, such as `3px 3px 0 var(--color-kui-accent)`.
- `--radius-kui-card`, `0px` by default, rounds the text fields and also Button, the framed IconButton, Card, CardRow, Widget, Notice, toasts, Dialog, CommandPalette and popovers, Menu included; a docked SidePanel stays square.
- Notice: `--kui-border-notice` and `--font-weight-kui-notice`, which a compact one takes too.
- Avatar: `--kui-border-avatar` and the colour `--color-kui-avatar-ring` for its ring, `--font-weight-kui-avatar` for the initial. The two borders follow `--kui-border-card` unless set.
- Offset shadows and a press-down, `none` and `0px` by default: `--kui-shadow-raised` under a Card, CardRow, Widget and toast, `--kui-shadow-press` under a Button and a framed IconButton (solid or danger), which move down by `--kui-press-travel` and drop that shadow while pressed. A brutalist skin: `--kui-shadow-raised: 4px 4px 0 var(--color-kui-text)`, `--kui-shadow-press: 3px 3px 0 var(--color-kui-text)`, `--kui-press-travel: 3px`.

The theme is dark unless the visitor's system asks for light. `data-theme="light"` or `data-theme="dark"` on `html` wins over both, for a site with its own switch, and on any element it themes what that element holds. A colour the app overrides with a single value stays that value in both.

```kay
---
import Toaster from '@kaynooo/kayjs-ui/toaster.kay'
import TooltipHost from '@kaynooo/kayjs-ui/tooltip-host.kay'
import '../app.css'
---
slot
Toaster
TooltipHost
```

## Settings

The icons the components draw come from slots, each named for what it means: `alert`, `back`, `chevron`, `close`, `delete`, `globe`, `info`, `menu`, `pause`, `play`, `plus`, `search`, `spinner`, `star`, `success`, `zoomFit`, `zoomIn`, `zoomOut`. The app replaces any of them through kay's library settings, spreading the defaults:

```ts
// kay.config.ts
export default defineConfig({ settings: { '@kaynooo/kayjs-ui': './src/ui-settings.ts' } })
```

```ts
// src/ui-settings.ts
import type { Settings } from '@kaynooo/kayjs-ui'
import { defaults } from '@kaynooo/kayjs-ui'
import close from '~icons/tabler/x'

const settings: Settings = { ...defaults, icons: { ...defaults.icons, close } }

export default settings
```

`kay check` checks this module against `Settings`. The server, the browser, `kay build` and `kay test` all render with it.

## Testing an app's use of it

A page that uses the components renders them in `testSite()` like the app's own. To test what their handlers do, `mountComponent(file, props)` from `kay/test` renders a component of the app into the DOM `kay/test/dom` registers, listed after `kay/test/preload` under `[test] preload` in bunfig.toml with `@happy-dom/global-registrator` installed; it shims the popover API happy-dom lacks, which Toaster and Popover use.

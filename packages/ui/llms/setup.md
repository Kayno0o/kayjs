# kayjs-ui: Setup, settings and testing

## Common tasks

### Setup

kayjs-ui is published as `@kaynooo/kayjs-ui` to `https://git.kaynooo.fr/api/packages/kaynooo/npm/`, beside kay. kay, Tailwind v4 and `@iconify-json/tabler` are peer dependencies. It is released with kay at its version and peers on kay's minor: the app installs the one matching its kay and moves them together.

```sh
kay add ui
```

It installs the package and `@iconify-json/tabler` (needing Tailwind in the app) and lists `ui()` from `@kaynooo/kayjs-ui/extension` in `extensions` in kay.config.ts. That one line brings the theme, a `Toaster` and a `TooltipHost` on every page, outside the app's layouts, so no layout or stylesheet names them. Doing it by hand, `bun add @kaynooo/kayjs-ui @iconify-json/tabler` and add `ui()`. The extension's stylesheet comes before the app's, so the app's own `@theme` overrides win.

Two peers are optional, installed only when used: `chartist` for `LineChart`, `hls.js` for an `.m3u8` video in a browser without native HLS.

`ui()` is the whole setup. An app writing the theme itself, as before, still works: `src/app.css`, imported by the root `_layout.kay`, imports it right after Tailwind. kay collects the classes of the library's templates along with the app's own, so no `@source` line has to point into `node_modules`:

```css
@import 'tailwindcss';
@import '@kaynooo/kayjs-ui/theme.css';
@source '../.kay/classes.txt';

@theme {
  --color-kui-accent: light-dark(#3b6fd4, #7aa2f7);
}
```

kay leaves out the theme's rules for the `kui-` classes no file of the app or component it renders writes whole, so an app ships the CSS of the components it uses; a class put together at runtime, or written only in a CMS body, is kept by writing it whole in any file of the app, for instance in a comment in `app.css` (see Using a component library in kay's `llms/component-libraries.md`).

The theme's tokens are `@theme default`, so the app's `@theme` overrides any of them wherever it sits. Each colour is `--color-kui-<name>`, used as `bg-kui-<name>` and the like, and holds `light-dark(light, dark)`. Eight are seeds a skin sets alone: `canvas`, `text`, `accent`, `success`, `warning`, `info`, `error` and `field-border`; every other colour except `chart-5` and `chart-6` derives from them with `color-mix` (`surface0` is the canvas with 3% of the text, `subtext0` the text with 30% of the canvas, and so on), in both schemes, so `@theme { --color-kui-canvas: ...; --color-kui-text: ...; ... }` with those eight reskins everything. A derived colour stays overridable on its own, and wins over its derivation. A seed must read at 4.5:1 on `mantle` and `surface1`, the deepest grounds (`field-border` at 3:1); a skin with one scheme writes its seeds once and sets `color-scheme` on `:root` to it, as `accent-hi` shades by the scheme. Set the seeds where the theme is computed, `:root` or `html` (`[data-theme=x]` on `html` too): a seed scoped to a subtree does not re-derive the colours inside it. Setting some seeds only moves what derives from them: a skin that sets `canvas` and not `surface0` gets a `surface0` derived from its canvas.

- Surfaces, deepest first: `mantle`, `canvas`, `surface0`, `surface1`.
- Hairlines: `surface2` and `overlay0`.
- Text: `text`, `overlay1` (the faintest), `subtext0` and `muted`.
- State: `accent`, `accent-hi` (its hover), `on-accent` (text on it), `success`, `warning`, `info` and `error`.
- Fills: `fill-hover`, `fill-danger` and `row-hover`.
- Fields: `field-border`, the solid border of a text field, which buttons, Toggle tracks, carousel dots and empty Rating stars draw too, at 3:1 on every surface, so an app changing its surfaces sets it to match; and `field-focus`, the border of a focused text field, `accent` unless set.
- Stamps (`Badge(stamp)`): `stamp` (its ink and hairline), `stamp-fill` and `stamp-fill-hover` (its ground while a `.group` holding it is hovered).
- Chart series: `chart-1` to `chart-6`.

A few components take tokens for their box and type, for a skin restyling them without redeclaring their selector:

- Keyline: `--kui-border-width`, `1px` by default, a length, sizes the border of Button, Card (and its head), CardRow, Widget, Notice, Avatar, toasts, Dialog, SidePanel, CommandPalette, popovers, tooltips, Table, a boxed CollapsibleSection, SaveForm's bar, Segmented, FileDrop, Pagination's steps, SiteNav's open list, chart tooltips, ChipGroup's chips, IconPicker's grid, the ScatterChart plot, ImageCropper's stage, Toggle's track and Table's filter and selection bars and narrow sort buttons. The crop frame and handles inside the stage keep their fixed borders, as they have to show over any photo. A value that is no length, such as the shorthand `2px solid red`, leaves it at 1px; text fields and Badge take `--kui-border-input` and `--kui-border-badge`. The old name `--kui-border-card` still sets it, until 1.61.
- Badge: `--kui-border-badge`, `--spacing-kui-badge-x`, `--spacing-kui-badge-y`, `--text-kui-badge`, `--tracking-kui-badge`, `--kui-badge-case` (`none` or `uppercase`) and `--kui-badge-font`, the text's own unless set, such as to `var(--font-mono)`, and `--kui-badge-solid-text`, the text colour of a `solid` badge (`--color-kui-on-accent` unless set); `--kui-border-stamp` for a stamp.
- Text fields, `kui-field-input` and a FormField's controls: `--spacing-kui-field-x` and `--spacing-kui-field-y` for the inset, `--kui-field-focus-shadow` for a shadow while focused, `none` by default, such as `3px 3px 0 var(--color-kui-accent)`.
- `--radius-kui-card`, `0px` by default, rounds the text fields and also Button, the framed IconButton, Card, CardRow, Widget, Notice, toasts, Dialog, CommandPalette and popovers, Menu included; a docked SidePanel stays square.
- Notice: `--kui-border-notice` and `--font-weight-kui-notice`, which a compact one takes too.
- Avatar: `--kui-border-avatar` and the colour `--color-kui-avatar-ring` for its ring, `--font-weight-kui-avatar` for the initial. The two borders follow `--kui-border-width` unless set.
- Offset shadows and a press-down, `none` and `0px` by default: `--kui-shadow-raised` under a Card, CardRow, Widget and toast, `--kui-shadow-press` under a Button and a framed IconButton (solid or danger), which move down by `--kui-press-travel` and drop that shadow while pressed. A brutalist skin: `--kui-shadow-raised: 4px 4px 0 var(--color-kui-text)`, `--kui-shadow-press: 3px 3px 0 var(--color-kui-text)`, `--kui-press-travel: 3px`.

The theme is dark unless the visitor's system asks for light. `data-theme="light"` or `data-theme="dark"` on `html` wins over both, for a site with its own switch, and on any element it themes what that element holds. A colour the app overrides with a single value stays that value in both.

A layout may still render its own `Toaster` and `TooltipHost`, as an app did before `ui()`: only the first mounted shows toasts and tooltips, so the two copies never double them.

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

The extension puts both islands on every page, so each page loads the hydration code, as the layout above does, and since the Toaster holds state `kay build` does not keep a page prerendered under it, as with the two in your own layout.

### Settings

The icons the components draw come from slots, each named for what it means: `alert`, `back`, `calendar`, `chevron`, `close`, `delete`, `globe`, `info`, `menu`, `pause`, `play`, `plus`, `search`, `spinner`, `star`, `success`, `zoomFit`, `zoomIn`, `zoomOut`. The app replaces any of them through kay's library settings, spreading the defaults:

```ts
// kay.config.ts
export default defineConfig({ settings: { '@kaynooo/kayjs-ui': './src/ui-settings.ts' } })
```

```ts
// src/ui-settings.ts
import type { UiSettings } from '@kaynooo/kayjs-ui'
import { uiDefaults } from '@kaynooo/kayjs-ui'
import close from '~icons/tabler/x'

const settings: UiSettings = { ...uiDefaults, icons: { ...uiDefaults.icons, close } }

export default settings
```

`kay check` checks this module against `UiSettings`. The server, the browser, `kay build` and `bun test` all render with it.

### Restyle a component

A component with parts takes its `class` as a string for the root or an object of parts, `Card(class={{ head: 'p-6' }})`. `src/ui.ts` restyles every instance of one, keyed by its import path ([Restyle a component from src/ui.ts](../../../llms/styles-and-assets.md#restyle-a-component-from-srcuits)):

```ts
import { defineUi } from 'kay'

export default defineUi({
  '@kaynooo/kayjs-ui/card.kay': { parts: { root: 'rounded-xl', head: 'p-6' } },
  '@kaynooo/kayjs-ui/button.kay': { variants: { tone: { danger: { root: 'bg-red-600' } } } },
})
```

- The components with parts: Button, Card, Dialog, Table, TextInput, Textarea, DateInput, DateRangeInput, TimeInput, Badge, Notice, Avatar, Stat, PageHeader, PageSection, EmptyState, CardRow, FormField, Checkbox, Toggle, Select, MultiSelect, RangeInput, Segmented, Rating, FileDrop, IconButton, CopyButton, Menu, Slider, Popover, TooltipHost, Toaster, SidePanel, CommandPalette, ConfirmDelete, FormDialog,
- Also with parts: SaveForm, ContactForm, CollapsibleSection, Widget, Meter, BarList, ChipGroup, Tabs, TabNav, SiteNav, AppHeader, Pagination, SplitLayout, TreeView, LoadMore and VirtualList.
- Each part keeps its `kui-` class, so a rule of yours on `.kui-card-head` keeps working beside the utilities. A utility of `src/ui.ts` or of `class` wins over a theme rule on the same property.
- A part is named after what its `kui-` class draws: Card has `root`, `head`, `title` and `body`; Dialog `root`, `title`, `body` and `footer`; Table `root` (the wrapper), `table`, `headCell`, `row`, `cell`, `cellBody`, `sortButton`, `sortIcon`, `filter`, `filterInput`, `count`, `selection`, `bulk` and `emptyCell`; Button `root` and `spinner`; DateInput `root`, `input`, `trigger`, `panel`, `head`, `title`, `step`, `grid`, `weekday`, `day` and `today`, DateRangeInput `root` and `separator`. The variants are the props that already exist: `tone` (Button, Badge, Notice), `variant` and `size` (Button). `kay check` reports a part or variant that does not exist.
- A Button with an `onClick` hands its root classes to its busy button, so `button.kay` reaches it, but its `spinner` part is set through the `@kaynooo/kayjs-ui/internal/busy-button.kay` key, `class={{ spinner: ... }}` included.
- FormField has `root`, `label`, `head`, `text`, `required`, `action`, `hint`, `issues` and `issue`; Checkbox `root`, `input`, `label` and `hint`; Toggle `root`, `input`, `track` and `label`; Select `root`; Slider `root`, `label`, `input` and `value`.
- RangeInput has `root`, `box`, `separator` and `unit`; Segmented `root`, `option`, `input`, `label` and `icon`; Rating `root`, `stars` and `fill`; FileDrop `root` and `input`; IconButton `root`; CopyButton `root`, `text` and `live`, with `tone` as its variant.
- MultiSelect has `root`, `panel`, `trigger`, `summary`, `chevron`, `search`, `bar`, `action`, `options`, `option`, `checkbox`, `icon`, `label` and `empty`.
- Menu has `menu` (the popover), `list`, `separator` and `item`; its `root` is the trigger, where a `class` string has always gone.
- Popover has `root` (the panel) and TooltipHost `root`; Toaster `root`, `live`, `toast`, `icon`, `message` and `dismiss`; SidePanel `root`, `head`, `title`, `body` and `footer`; CollapsibleSection `root`, `summary`, `title`, `meta`, `chevron` and `body`; Widget `root`, `head` and `title`.
- Meter has `root` and `fill` (its `fillClass` still works); BarList `root`, `row`, `label`, `value`, `track` and `fill`, `root` being the empty message too; ChipGroup `root`, `chip`, `input`, `label` and `icon`; SaveForm `root`, `grid`, `bar`, `status` and `actions`.
- CommandPalette has `root`, `search`, `input`, `list`, `heading`, `option`, `text`, `label`, `snippet`, `more`, `group`, `empty` and `count`; FormDialog `root` (the Dialog), `footer`, `actions` and `form`; ContactForm `root`, `consent`, `box`, `boxInput`, `boxLabel`, `issues` and `issue`.
- ConfirmDelete has `root` (the trigger, where `class` has always gone), `armed` and `message`.
- Tabs has `root`, `list`, `tab`, `icon` and `panel`; TabNav `root` and `link`; SiteNav `root`, `toggle`, `menuIcon`, `closeIcon`, `list`, `link` and `icon`; AppHeader `root`, `brand`, `nav` (its SiteNav) and `end`; Pagination `root`, `step`, `gap` and `page`.
- SplitLayout has `root`, `sidebar`, `sidebarHead`, `sidebarTitle`, `sidebarBody`, `list`, `listHead`, `resizer`, `detail` and `detailHead`; TreeView `root`, `item`, `toggle`, `icon` and `label`; LoadMore `root`, `failed` and `loading`; VirtualList `root`.
- The other components have no parts yet and still restyle through their `kui-` classes.

### Testing an app's use of it

A page that uses the components renders them in `testSite()` like the app's own. To test what their handlers do, `mountComponent(file, props)` from `kay/test` renders a component of the app into the DOM `kay/test/dom` registers, listed after `kay/test/preload` under `[test] preload` in bunfig.toml with `@happy-dom/global-registrator` installed; it shims the popover API happy-dom lacks, which Toaster and Popover use.

## Reference

- Import each component by its `.kay` path: `import Button from '@kaynooo/kayjs-ui/button.kay'`. Types, `toast`, `attempt`, `messageOf`, `editing`, `infiniteList` and the defaults come from the package itself: `import { toast } from '@kaynooo/kayjs-ui'`, and the drag and drop controllers from `@kaynooo/kayjs-ui/dnd`.
- Components write no Tailwind utility, only the classes of `theme.css`, every one prefixed `kui-` as its tokens are, so a site's own `btn`, `card` or `--color-accent` never meets them. A rule of the app's on one of those classes restyles every instance, and `--kui-border-width` sets the keyline of every framed box; utilities passed through a component's `class` prop restyle one, and `src/ui.ts` restyles the parts of a component with some, see [Restyle a component](#restyle-a-component).
- `toast` only shows in the browser, called from an island. The server's toast list, shared by every request, stays empty. `ui()` in kay.config.ts (`kay add ui`) mounts one `Toaster`, one `TooltipHost` and the theme on every page. An extension may render its own: while one is mounted, a second renders nothing until the first unmounts.

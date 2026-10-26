---
title: kayjs-ui
order: 3
description: A set of kay components styled by one theme you restyle from your own stylesheet.
---
`@kaynooo/kayjs-ui` is a set of `.kay` components that your app compiles as its own, styled by the classes of one `theme.css`. Components use `kui-` prefixed classes, and utilities in the recipes that hold their look, so they never meet your own.

## Install

In a kay project with Tailwind, `kay add ui` does the install and lists `ui()` in `kay.config.ts`, which brings the theme, a `Toaster` and a `TooltipHost` to every page: nothing else is wired. Otherwise:

```sh
bun add @kaynooo/kayjs-ui @iconify-json/tabler
```

```ts
// kay.config.ts
import { defineConfig } from 'kay/server'
import { ui } from '@kaynooo/kayjs-ui/extension'

export default defineConfig({ extensions: [ui()] })
```

The `@kaynooo` scope must point at the Forgejo registry. A project made by `kay new` already has it in its `.npmrc`; for another, see [Installation](/getting-started/installation).

kay and Tailwind v4 are peers, and the default icons are Tabler's. Three peers are optional: `bun add chartist` for `LineChart`, `bun add leaflet @types/leaflet` for `Map`, and `bun add hls.js` for an `.m3u8` video in a browser without native HLS. kayjs-ui is released with kay, at kay's own version, and peers on kay's minor. Install the one matching your kay and move them together.

An app on a `^0.x` range moves to kay's version by hand, as a caret on 0.x never reaches it.

## Theme

`ui()` brings the theme, and its stylesheet comes before yours. To override tokens, write your own `@theme` in `src/app.css`, importing the theme there too if you want the tokens beside the overrides.

```css
@import 'tailwindcss';
@import '@kaynooo/kayjs-ui/theme.css';

@theme {
  --color-accent: light-dark(#3b6fd4, #7aa2f7);
}
```

To use a theme utility in `@apply`, such as `@apply border border-border bg-popover`, write it in `src/app.css`, with nothing else: `ui()` gives that stylesheet the tokens and writes no rule, so the theme is not loaded a second time. An `@reference '@kaynooo/kayjs-ui/theme.css';` you already wrote keeps working. Without `ui()`, start the stylesheet with that line, or the build fails with `Cannot apply unknown utility class`.

Your stylesheet ships only the rules of the components you render. kay drops every `kui-` rule whose class no file of your app, and no component it renders, writes whole.

A class you put together at runtime, such as `kui-btn-${tone}`, is not seen. Write it in full in any file of your app, such as a comment in `app.css`, to keep its rules.

### Tokens

The palette button in this site's header picks a theme, from Catppuccin to Tokyo Night, and a scheme. The whole site follows, its code included. Your `@theme` sets the theme picked so.

<ThemeTokens />

Colours are named as the app names them (`--color-accent`, `--color-background`, `--color-danger`), so one theme feeds your app and the library, and the utilities are yours too (`bg-surface`, `text-muted`, `border-border`). They hold `light-dark(light, dark)`.

An app built from kay's template already sets `--color-base`, `--color-text` and `--color-error`, which `background`, `foreground` and `danger` fall back to. A name your app already sets for its own use, such as `--color-accent` or `--radius-md`, drives kayjs-ui too: that is the point of one theme. `--color-input` is the solid line of text fields, buttons, toggles, carousel dots and empty stars, at 3:1 on every surface. A palette that changes the surfaces sets it to match.

Eight colours are seeds: `--color-background`, `--color-foreground`, `--color-accent`, `--color-success`, `--color-warning`, `--color-info`, `--color-danger` and `--color-input`. Set those eight in your `@theme` and every other colour follows: the surfaces and greys are mixed from the background and the text, the hairlines are the text at an alpha, and the accent's hover is the accent shaded. A seed must read at 4.5:1 on `popover` and `surface-strong`, the deepest surfaces, and `input` at 3:1.

Set them on `:root` or `html`, as `@theme` does: a seed set on one element does not change the colours mixed inside it. A colour you set yourself wins over the one mixed for it. A site in one scheme writes each seed once and sets `color-scheme` on `:root` to it.

`--border-width` is the keyline of buttons, cards, rows, widgets, notices, avatars, toasts, dialogs, side panels, tooltips, tables, boxed sections, segmented controls, chips, toggles, chart plots and the other framed boxes. The dashed frame and the handles the image cropper draws around the crop keep their fixed borders, as they have to show over any photo. It is a length: `2px`, not `2px solid red`, which it ignores.

Labels, headings and table heads are uppercase unless `--label-case` is `none`, and `--font-label` sets their font. Three skins ship, `@kaynooo/kayjs-ui/skins/brutalist.css` (which sets the three shadow tokens below), `soft.css` and `space.css`, imported after `theme.css`; an app importing none keeps the default theme, and your own `@theme` after one wins.

The space skin is dark only: a near-black background, a starlight accent, red kept for errors, and no lines around boxes, where the fill tells them apart. Buttons become hairline keys that light in the accent on hover, checkboxes are drawn, selects are themed, and the `starfield` class paints tiled dots behind a page or a section. It uses Space Grotesk, which you serve with `fonts: [{ fontsource: '@fontsource-variable/space-grotesk' }]` in `kay.config.ts`.

Besides its colours, the space skin sets these, so an override of yours knows what it changes:

- The sans font, `--color-popover`, `--color-surface`, `--color-surface-strong`, `--color-border` and `--color-border-strong`.
- `--border-width` to `0`, put back to `1px` on buttons, fields, chips, toggles, badges, notices, avatars, segmented controls, file drops and pagination steps.
- `--label-case` to `none`, `--tracking-label` and `color-scheme: dark`.
- The line of Segmented and FileDrop, and of pagination steps and unchecked chips, in `--color-input`.
- A shadow under overlays, and drawn checkboxes that outline in the accent on hover.
- Themed selects: a chevron, and where the browser allows it the open list and its options.
- The key look of buttons and framed icon buttons: a hairline, lit in the accent on hover. Tone, ghost, inline, pressed and disabled buttons keep the theme's look, and a focused button shows the theme's focus line.

Soft sets `--label-case`, `--tracking-label` and `--shadow-raised`. Brutalist sets `--border-width`, the three radii, `--font-label` and the three shadow tokens.

A skin's rules sit at one class of specificity or none, so a rule of yours with one class in `@layer components` beats them. Unlayered CSS and the classes of `src/ui.ts` already did. The key's hover is the one exception, at two classes like the theme's own.

`starfield` draws four dots over `--color-background`, fixed to the viewport, and `class="starfield bg-surface"` changes the ground. A `bg-[radial-gradient(...)]` utility replaces the dots instead of adding to them. For a fuller sky, write your own `background-image` that repeats the dots and adds your gradients, with its own `background-size`.

Add the one line to `src/app.css`, after the theme import (an app using `ui()` has the theme already, so it goes after `@import 'tailwindcss'`):

```css
@import '@kaynooo/kayjs-ui/skins/space.css';
```

Corners are Tailwind's own `--radius-sm` (badges, toggle thumbs), `--radius-md` (buttons, fields, chips, toggle tracks) and `--radius-lg` (cards, dialogs, popovers, notices), and avatars are round. Set all three to `0` for square corners. `--font-mono` is the monospace of the markdown editor and code, and `--density` (`1`) multiplies the card, inline and section gaps and the field insets.

A few tokens shape boxes rather than colour them. A setting only one component reads is no token: restyle that component everywhere in `src/ui.ts`, or one instance with `class`. A brutalist skin sets `--shadow-raised` (under cards, rows, widgets and toasts), `--shadow-press` (under framed buttons) and `--press-travel` (how far a pressed button moves down). All three draw nothing by default.

A button's hairline and fill are `--shell-line` and `--shell-fill`, shared by Button, a framed IconButton and a stat badge. Set them on the part in `src/ui.ts`, such as `Button: { parts: { root: '[--shell-line:var(--color-accent)] hover:[--shell-fill:transparent]' } }`, so your value wins over the theme's.

### Light or dark

The theme is dark unless the visitor's system asks for light. `data-theme="light"` or `"dark"` on `html` wins over both. A site in one theme sets it in its root layout's `head` block.

```kay
head
  html(data-theme="light")
slot
```

### Toaster and tooltips

`ui()` renders one `Toaster` and one `TooltipHost` after every page's layouts. Alt and T moves focus to the toasts on screen, and Escape dismisses the focused one. A layout that renders its own, as below, keeps working: only the first one mounted shows toasts and tooltips.

For a hover explanation of read-only text, such as a stat, write `data-hint="Damage per second"` instead of `data-tooltip`: the host shows it under the pointer only, and `kay check` does not report it as an `unreachable-tooltip`. A hint only adds to what the element already says, as the keyboard and screen readers never reach it.

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

## Using a component

Import each component by its `.kay` path. Types, `toast`, `attempt`, `messageOf`, `editing` and `infiniteList` come from the package itself.

```kay
---
import { toast } from '@kaynooo/kayjs-ui'
import Button from '@kaynooo/kayjs-ui/button.kay'

const save = () => toast.success('Saved')
---
Button(label="Save" tone="accent" onClick={save})
```

## Restyle a component

A component with parts takes its `class` as a string for the root or an object of parts, `Card(class={{ head: 'p-6' }})`. `src/ui.ts` restyles every instance of one, keyed by its name, with its import path as the fallback ([Restyle a component from src/ui.ts](/essentials/styling-and-assets/#restyle-a-component-from-srcuits)):

```ts
import { defineUi } from 'kay'

export default defineUi({
  Card: { parts: { root: 'rounded-xl', head: 'p-6' } },
  Button: { variants: { tone: { danger: { root: 'bg-red-600' }, brand: { root: 'bg-brand' } } } },
})
```

A variant or value the component lacks is added: `Button(tone="brand")` types and renders.

- The components with parts: Button, Card, Dialog, Table, TextInput, Textarea, DateInput, DateRangeInput, TimeInput, Badge, Notice, Avatar, Stat, PageHeader, PageSection, EmptyState, CardRow, FormField, Checkbox, Toggle, Select, MultiSelect, RangeInput, Segmented, Rating, FileDrop, IconButton, CopyButton, Menu, Slider, ColorInput, Popover, HoverCard, TooltipHost, Toaster, SidePanel, Toolbar, CommandPalette, ConfirmDelete, FormDialog.
- Also with parts: SaveForm, ContactForm, SubscribeForm, CollapsibleSection, Widget, Meter, BarList, ChipGroup, Tabs, TabNav, SiteNav, AppHeader, AppSwitcher, Pagination, SplitLayout, TreeView, Timeline, LoadMore, VirtualList, BarChart, LineChart, ScatterChart, Map, ContributionGraph, Carousel, Masonry, MediaGallery, ImageCropper, ZoomPane, QrCode, SiteFavicon, Icon, IconPicker, MarkdownEditor and WhenVisible.
- Card, Badge and Notice (1.71) hold their look in a recipe, and so do Avatar, Stat, PageHeader, PageSection, EmptyState, CardRow, Widget, Meter, Progress and Skeleton (1.72), then Button, IconButton, FormField, Checkbox, Toggle, TextInput, Textarea and Select (1.72), and the charts and media components too (1.72). `theme.css` has no rule for their part classes since 1.74.
- RadioGroup, Segmented, Rating, Slider, ColorInput, DateInput, DateRangeInput, Combobox, MultiSelect, ChipGroup, FileDrop, CopyButton and ConfirmDelete follow the same way (1.72), and so do the overlays: Dialog, FormDialog, Menu, BellInbox, Popover, HoverCard, SidePanel, CommandPalette, Toaster and TooltipHost. A Dialog `size` is a recipe variant, so a `max-w-*` in `src/ui.ts` or `class` replaces its width.
- In those, the root keeps its `kui-` class (`kui-card`, `kui-badge`, `kui-stat-badge`) as a name for your CSS, and the other parts carry `data-part` alone (`.kui-card > [data-part='head']`, a child selector, as `head`, `title` and `body` are names other components use too).
- A recipe holds the look as utilities, so `src/ui.ts` or `class` replaces the one it sets, such as `p-6` for the padding it sets, instead of overriding a rule. A rule of yours selecting a removed part class matches nothing. A utility of `src/ui.ts` or of `class` wins over a theme rule on the same property.
- A part is named after what its `kui-` class draws: Card has `root`, `head`, `title` and `body`, Dialog `root`, `title`, `body` and `footer`, Button `root` and `spinner`.
- Table has `root` (the wrapper), `table`, `head`, `headRow`, `headCell`, `body`, `row`, `cell`, `cellBody`, `cellLabel`, `sortButton`, `sortIcon`, `filter`, `filterLabel`, `filterInput`, `count`, `selection`, `selected`, `bulk`, `selectHead`, `selectCell`, `selectText`, `spacer` and `emptyCell`.
- DateInput has `root`, `input`, `trigger`, `panel`, `head`, `title`, `step`, `stepIcon`, `grid`, `weekday`, `weekdayRow`, `week`, `cell`, `day` and `today`, DateRangeInput `root` and `separator`, TimeInput `root`.
- The variants are the props that already exist, and `src/ui.ts` can add more: `tone` (Button, Badge, Notice, CopyButton), `variant` and `size` (Button). `kay check` reports a part that does not exist.
- A Button with an `onClick` hands its root and spinner classes to its busy button, so `button.kay` reaches both.
- FormField has `root`, `label`, `head`, `text`, `required`, `action`, `hint`, `issues` and `issue`; Checkbox `root`, `input`, `label` and `hint`; Toggle `root`, `input`, `track` and `label`; Select `root`; Slider `root`, `label`, `input` and `value`; ColorInput `root`, `input`, `label` and `value`.
- RangeInput has `root`, `box`, `separator` and `unit`; Segmented `root`, `option`, `input`, `label` and `icon`; Rating `root`, `stars` and `fill`; FileDrop `root` and `input`; IconButton and BareIconButton `root`; CopyButton `root`, `text` and `live`, with `tone` as its variant.
- MultiSelect has `root`, `panel`, `trigger`, `summary`, `chevron`, `search`, `bar`, `action`, `options`, `option`, `checkbox`, `icon`, `label` and `empty`.
- Menu has `menu` (the popover), `list`, `separator` and `item`; its `root` is the trigger, where a `class` string has always gone.
- Popover has `root` (the panel), HoverCard `root` and TooltipHost `root`; Toaster `root`, `live`, `toast`, `icon`, `message` and `dismiss`; SidePanel `root`, `head`, `title`, `body`, `footer` and `launcher`; Toolbar `root` and `caption`; PageSection `root`, `head`, `title`, `heading` and `subtitle`; CollapsibleSection `root`, `summary`, `title`, `meta`, `chevron` and `body`; Widget `root`, `head` and `title`.
- Meter has `root` and `fill` (its `fillClass` still works); BarList `root`, `item`, `row`, `label`, `value`, `track` and `fill`, `root` being the empty message too; ChipGroup `root`, `chip`, `input`, `label` and `icon`; SaveForm `root`, `grid`, `bar`, `status` and `actions`.
- CommandPalette has `root`, `search`, `input`, `list`, `section`, `heading`, `option`, `text`, `label`, `snippet`, `more`, `group`, `empty` and `count`; FormDialog `root` (the Dialog), `footer`, `actions` and `form`; ContactForm `root`, `consent`, `link`, `privacy`, `issues` and `issue`; SubscribeForm `root`, `notice` and `link`.
- ConfirmDelete has `root` (the trigger, where `class` has always gone), `armed` and `message`.
- Tabs has `root`, `list`, `tab`, `icon` and `panel`; TabNav `root` and `link`; SiteNav `root`, `toggle`, `menuIcon`, `closeIcon`, `list`, `item`, `link` and `icon`; AppHeader `root`, `brand`, `nav` (its SiteNav) and `end`; AppSwitcher `root` (the trigger), `menu`, `grid`, `tile`, `icon`, `initial` and `name`; Pagination `root`, `step`, `gap` and `page`; Timeline `root`, `item`, `entry`, `time`, `icon` and `text`.
- SplitLayout has `root`, `sidebar`, `sidebarHead`, `sidebarTitle`, `sidebarBody`, `list`, `listHead`, `resizer`, `detail` and `detailHead`; TreeView `root`, `item`, `toggle`, `icon` and `label`; LoadMore `root`, `failed`, `message`, `loading`, `text` and `announced`; VirtualList `root`, `content` and `item`.
- BarChart has `root` (the empty message too), `plot`, `grid`, `tick`, `columns`, `column`, `bar`, `axis`, `axisLabel`, `legend`, `legendItem` and `key`.
- LineChart has `root`, `frame`, `plot`, `cursor`, `dot`, `band`, `overlay`, `tooltip`, `tooltipLabel`, `tooltipRow`, `tooltipName`, `tooltipValue`, `swatch`, `data`, `hint`, `legend`, `legendItem` and `key`; ScatterChart `root` (the empty message too), `axisLabel`, `plot`, `grid`, `tick`, `guide`, `corner` and `dot`; ContributionGraph `root`, `month` and `cell`.
- Carousel has `root`, `viewport`, `slide`, `image`, `controls`, `step`, `dot` and `pause`; Masonry `root` and `tile`; MediaGallery `root` (the empty message too), `stage`, `frame`, `zoom`, `step`, `counter`, `caption`, `strip`, `thumb`, `thumbImage`, `play`, `lightbox`, `full` and `close`; ImageCropper `root`, `stage`, `image`, `crop`, `gridCols`, `gridRows` and `handle`.
- Map has `root`, `canvas`, `surface`, `list` and `item`; ZoomPane has `root`, `plate` and `tools`; QrCode, SiteFavicon (`root`, `img`, `icon`), Icon and WhenVisible `root`; IconPicker `root`, `search`, `grid`, `item`, `option`, `empty`, `bar`, `selection`, `clear`, `error` and `more`; MarkdownEditor `wrap`, `grid`, `root` (the textarea), `bar` and `barFailed`.
- Accordion `root`; Skeleton `root`, `block` and `label`; Progress `root` and `fill`; Breadcrumb `root`, `list`, `more`, `item`, `link` and `text`; RadioGroup `root`, `radio`, `choice`, `input`, `label` and `description`; MarkdownEditor's preview `root`, `failed` and `body`, its `previewClass` string landing on `body`.

Every element of a component that an app could style carries `data-part` (hidden inputs, a chart's hidden data table and a few layout rows aside), so no class has to be known to restyle it.

A state is the ARIA attribute where ARIA has one (`aria-expanded`, `aria-checked`, `aria-selected`, `aria-current`, `aria-pressed`, `aria-busy`, `aria-disabled` or `disabled`), and a named `data-*` attribute where it has none (`data-placement`, `data-dragging`, `data-direction`, a Steps item's `data-step`). There is no `data-state` repeating an ARIA state. Tailwind's `aria-selected:` and `data-dragging:` variants style both from `src/ui.ts`.

<Callout type="warning">

A page can pass a Dialog or a Popover its content. A layout, or a page with a `--- server` fence, cannot pass a function or a block with parameters, such as a Table's `@cell`, but can pass an action. Put those in a component of yours, which then renders as an island.

</Callout>

## Copy a component

A recipe in `src/ui.ts` cannot change a component's markup. For that, `kay ui eject card` copies `card.kay` into `src/components/ui/`, with the files only it uses, and points your imports of `@kaynooo/kayjs-ui/card.kay` in `src/`, `tests/` and the `.ts` files at the root, such as `kay.config.ts`, at the copy. You then edit it like any of your components. Messages and the theme keep working, as they are not part of the file.

Files other components share, such as `icon.kay`, stay in the library, and the copy imports them from `@kaynooo/kayjs-ui/<name>.kay` or `@kaynooo/kayjs-ui/lib/<name>`, which is for such copies and not a stable API.

Components of the library that use the one you copied, such as `FormDialog` for `Dialog`, keep the library's version; the command lists them. An entry of `src/ui.ts` keyed by the import path is repeated under the copy's path, so both keep your look. One keyed by the name (`Card`) becomes the library's path key plus the copy's, as a name names two components after the copy. `--dry-run` shows what would change without writing.

The command records the version and the library's text of each copy in `src/components/ui/.upstream/`, to commit with it. After a kayjs-ui update, `kay ui diff` prints what the library changed in each copy since then, with the `git merge-file` line that merges it. Once merged, `kay ui diff card --accept` records the installed text, and `--check` makes the command exit 1 when anything changed, for CI.

A file the copy imports from the library without taking it, such as `defaults.ts`, is reported too when it changed or went, as the copy would break at build time without a word. If a file in `.upstream/` is damaged or missing, the command names it and stops.

## Settings

Icons are slots (`close`, `delete`, `search`, ...) mapped to any icon set. Replace some in your own settings module.

```ts
// kay.config.ts
export default defineConfig({
  settings: { '@kaynooo/kayjs-ui': './src/ui-settings.ts' },
})
```

```ts
// src/ui-settings.ts
import type { UiSettings } from '@kaynooo/kayjs-ui'
import { uiDefaults } from '@kaynooo/kayjs-ui'
import close from '~icons/tabler/circle-x'

const settings: UiSettings = { ...uiDefaults, icons: { ...uiDefaults.icons, close } }

export default settings
```

## Languages

kayjs-ui comes with its French: on a French page every default text reads in French, with nothing to set up.

For another language, or a different French word, use your messages. The words a component shows by default, `Close`, `Cancel`, `Loading…`, are looked up there before their English. Word them once in `src/messages/<locale>.ts` under `ui`, named for the component and the prop, and every instance reads them.

```ts
// src/messages/fr.ts
export default defineMessages({
  ui: {
    sidePanel: { close: 'Fermer' },
    pagination: { previous: 'Précédent', next: 'Suivant' },
    table: { rowCount: { one: '{count} ligne', other: '{count} lignes' } },
  },
})
```

Your own key wins over the French kayjs-ui ships, and a prop you pass to one component still replaces the message for that component. The months and days a chart draws follow the page's locale too.

<ReadMore href="/llms/kayjs-ui-words">Every `ui.*` key and its English is in the full kayjs-ui reference.</ReadMore>

## Components

Actions: [Button](/ui/button), [IconButton](/ui/icon-button), [BareIconButton](/ui/bare-icon-button), [ConfirmDelete](/ui/confirm-delete), [CopyButton](/ui/copy-button), [Menu](/ui/menu), [Toggle](/ui/toggle).

Overlays: [Dialog](/ui/dialog), [FormDialog](/ui/form-dialog), [SidePanel](/ui/side-panel), [Popover](/ui/popover), [HoverCard](/ui/hover-card), [TooltipHost](/ui/tooltip-host), [Toaster](/ui/toaster), [CommandPalette](/ui/command-palette).

Forms: [FormField](/ui/form-field), [SaveForm](/ui/save-form), [ContactForm](/ui/contact-form), [SubscribeForm](/ui/subscribe-form), [TextInput](/ui/text-input), [Checkbox](/ui/checkbox), [ChipGroup](/ui/chip-group), [RadioGroup](/ui/radio-group), [Select](/ui/select), [MultiSelect](/ui/multi-select), [Combobox](/ui/combobox), [Textarea](/ui/textarea)

More inputs: [RangeInput](/ui/range-input), [Slider](/ui/slider), [ColorInput](/ui/color-input), [FileDrop](/ui/file-drop), [IconPicker](/ui/icon-picker), [MarkdownEditor](/ui/markdown-editor), [ImageCropper](/ui/image-cropper), [Rating](/ui/rating).

Dates and times: [DateInput](/ui/date-input), [DateRangeInput](/ui/date-range-input), [TimeInput](/ui/time-input).

Layout: [Card](/ui/card), [CardRow](/ui/card-row), [PageHeader](/ui/page-header), [PageSection](/ui/page-section), [CollapsibleSection](/ui/collapsible-section), [Widget](/ui/widget), [SplitLayout](/ui/split-layout), [EmptyState](/ui/empty-state), [Notice](/ui/notice), [Toolbar](/ui/toolbar), [Masonry](/ui/masonry).

Navigation: [Tabs](/ui/tabs), [TabNav](/ui/tab-nav), [Breadcrumb](/ui/breadcrumb), [Segmented](/ui/segmented), [SiteNav](/ui/site-nav), [AppHeader](/ui/app-header), [AppSwitcher](/ui/app-switcher), [Pagination](/ui/pagination), [Steps](/ui/steps), [TreeView](/ui/tree-view), [Timeline](/ui/timeline).

Data: [Table](/ui/table), [Stat](/ui/stat), [Meter](/ui/meter), [BarList](/ui/bar-list), [Badge](/ui/badge), [Avatar](/ui/avatar), [LineChart](/ui/line-chart), [BarChart](/ui/bar-chart), [ScatterChart](/ui/scatter-chart), [Map](/ui/map), [ContributionGraph](/ui/contribution-graph), [QrCode](/ui/qr-code), [SiteFavicon](/ui/site-favicon), [Icon](/ui/icon).

Media: [MediaGallery](/ui/media-gallery), [Carousel](/ui/carousel), [ZoomPane](/ui/zoom-pane), [WhenVisible](/ui/when-visible), [LoadMore](/ui/load-more), [VirtualList](/ui/virtual-list).

Drag and drop (`Sortable`, `Board`, `DropTargets`) comes from `@kaynooo/kayjs-ui/dnd` and is in the full reference. A move by arrow key is said to screen readers: where the item landed, as `Moved to 2 of 3`. A handle with no label or text of its own is named `Reorder` and the item's label or text, such as `Reorder Milk`, without the text of the buttons beside it, and it follows the item's text when that changes; give it an `aria-label` to say more.

<ReadMore href="/llms/kayjs-ui">Every component's props, forms with FormDialog, drag and drop, label translation and testing are in the full kayjs-ui reference.</ReadMore>

## Reference

Topics of the kayjs-ui reference the sections above do not link:

- [Setup, settings and testing](/llms/kayjs-ui-setup)
- [Icons, buttons, toasts, dialogs, cards, popovers and stats](/llms/kayjs-ui-basics)
- [Inputs, selects, editors and forms](/llms/kayjs-ui-forms)
- [Forms, FormDialog and Steps](/llms/kayjs-ui-forms-and-steps)
- [Tables, tabs and pagination](/llms/kayjs-ui-tables-navigation-and-layout)
- [Page layout, command palette and trees](/llms/kayjs-ui-page-layout-palette-and-trees)
- [Charts, drag and drop, galleries and image tools](/llms/kayjs-ui-charts-drag-and-media)

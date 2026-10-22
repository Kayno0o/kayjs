---
title: kayjs-ui
order: 3
description: A set of kay components styled by one theme you restyle from your own stylesheet.
---
`@kaynooo/kayjs-ui` is a set of `.kay` components that your app compiles as its own, styled by the classes of one `theme.css`. Components use only `kui-` prefixed classes, so they never meet your own.

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

kay and Tailwind v4 are peers, and the default icons are Tabler's. Two peers are optional: `bun add chartist` for `LineChart`, and `bun add hls.js` for an `.m3u8` video in a browser without native HLS. kayjs-ui is released with kay, at kay's own version, and peers on kay's minor. Install the one matching your kay and move them together.

An app on a `^0.x` range moves to kay's version by hand, as a caret on 0.x never reaches it.

## Theme

`ui()` brings the theme, and its stylesheet comes before yours. To override tokens, write your own `@theme` in `src/app.css`, importing the theme there too if you want the tokens beside the overrides.

```css
@import 'tailwindcss';
@import '@kaynooo/kayjs-ui/theme.css';
@source '../.kay/classes.txt';

@theme {
  --color-kui-accent: light-dark(#3b6fd4, #7aa2f7);
}
```

Your stylesheet ships only the rules of the components you render. kay drops every `kui-` rule whose class no file of your app, and no component it renders, writes whole.

A class you put together at runtime, such as `kui-btn-${tone}`, is not seen. Write it in full in any file of your app, such as a comment in `app.css`, to keep its rules.

### Tokens

The palette button in this site's header picks a theme, from Catppuccin to Tokyo Night, and a scheme. The whole site follows, its code included. Your `@theme` sets the theme picked so.

<ThemeTokens />

Colours are `--color-kui-<name>`, used as `bg-kui-<name>`, and hold `light-dark(light, dark)`. `--color-kui-field-border` is the solid line of text fields, buttons, toggles, carousel dots and empty stars, at 3:1 on every surface. A palette that changes the surfaces sets it to match.

Eight colours are seeds: `canvas`, `text`, `accent`, `success`, `warning`, `info`, `error` and `field-border`. Set those eight in your `@theme` and every other colour follows: the surfaces and greys are mixed from the canvas and the text, the hairlines are the text at an alpha, and the accent's hover is the accent shaded. A seed must read at 4.5:1 on `mantle` and `surface1`, the deepest surfaces, and `field-border` at 3:1.

Set them on `:root` or `html`, as `@theme` does: a seed set on one element does not change the colours mixed inside it. A colour you set yourself wins over the one mixed for it. A site in one scheme writes each seed once and sets `color-scheme` on `:root` to it.

`--kui-border-width` is the keyline of buttons, cards, rows, widgets, notices, avatars, toasts, dialogs, side panels, tooltips, tables, boxed sections, segmented controls, chips, toggles, chart plots and the other framed boxes. The dashed frame and the handles the image cropper draws around the crop keep their fixed borders, as they have to show over any photo. It is a length: `2px`, not `2px solid red`, which it ignores. The old name, `--kui-border-card`, works until 1.61.

A few tokens shape boxes rather than colour them. A brutalist skin sets `--kui-shadow-raised` (under cards, rows, widgets and toasts), `--kui-shadow-press` (under framed buttons) and `--kui-press-travel` (how far a pressed button moves down). All three draw nothing by default.

### Light or dark

The theme is dark unless the visitor's system asks for light. `data-theme="light"` or `"dark"` on `html` wins over both. A site in one theme sets it in its root layout's `head` block.

```kay
head
  html(data-theme="light")
slot
```

### Toaster and tooltips

`ui()` renders one `Toaster` and one `TooltipHost` after every page's layouts. Alt and T moves focus to the toasts on screen, and Escape dismisses the focused one. A layout that renders its own, as below, keeps working: only the first one mounted shows toasts and tooltips.

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

A component with parts takes its `class` as a string for the root or an object of parts, `Card(class={{ head: 'p-6' }})`. `src/ui.ts` restyles every instance of one, keyed by its import path ([Restyle a component from src/ui.ts](/essentials/styling-and-assets/#restyle-a-component-from-srcuits)):

```ts
import { defineUi } from 'kay'

export default defineUi({
  '@kaynooo/kayjs-ui/card.kay': { parts: { root: 'rounded-xl', head: 'p-6' } },
  '@kaynooo/kayjs-ui/button.kay': { variants: { tone: { danger: { root: 'bg-red-600' } } } },
})
```

- The components with parts: Button, Card, Dialog, Table, TextInput, Textarea, DateInput, DateRangeInput, TimeInput, Badge, Notice, Avatar, Stat, PageHeader, PageSection, EmptyState, CardRow, FormField, Checkbox, Toggle, Select, MultiSelect, RangeInput, Segmented, Rating, FileDrop, IconButton, CopyButton, Menu, Slider, Popover, TooltipHost, Toaster, SidePanel, CommandPalette, ConfirmDelete, FormDialog.
- Also with parts: SaveForm, ContactForm, CollapsibleSection, Widget, Meter, BarList, ChipGroup, Tabs, TabNav, SiteNav, AppHeader, Pagination, SplitLayout, TreeView, LoadMore, VirtualList, BarChart, LineChart, ScatterChart, ContributionGraph, Carousel, Masonry, MediaGallery, ImageCropper, ZoomPane, QrCode, SiteFavicon, Icon, IconPicker, MarkdownEditor and WhenVisible.
- Each part keeps its `kui-` class, so a rule of yours on `.kui-card-head` keeps working beside the utilities. A utility of `src/ui.ts` or of `class` wins over a theme rule on the same property.
- A part is named after what its `kui-` class draws: Card has `root`, `head`, `title` and `body`, Dialog `root`, `title`, `body` and `footer`, Button `root` and `spinner`.
- Table has `root` (the wrapper), `table`, `headCell`, `row`, `cell`, `cellBody`, `sortButton`, `sortIcon`, `filter`, `filterInput`, `count`, `selection`, `bulk` and `emptyCell`.
- DateInput has `root`, `input`, `trigger`, `panel`, `head`, `title`, `step`, `grid`, `weekday`, `day` and `today`, DateRangeInput `root` and `separator`, TimeInput `root`.
- The variants are the props that already exist: `tone` (Button, Badge, Notice, CopyButton), `variant` and `size` (Button). `kay check` reports a part or variant that does not exist.
- A Button with an `onClick` hands its root classes to its busy button, so `button.kay` reaches it, but its `spinner` part is set through the `@kaynooo/kayjs-ui/internal/busy-button.kay` key, `class={{ spinner: ... }}` included.
- FormField has `root`, `label`, `head`, `text`, `required`, `action`, `hint`, `issues` and `issue`; Checkbox `root`, `input`, `label` and `hint`; Toggle `root`, `input`, `track` and `label`; Select `root`; Slider `root`, `label`, `input` and `value`.
- RangeInput has `root`, `box`, `separator` and `unit`; Segmented `root`, `option`, `input`, `label` and `icon`; Rating `root`, `stars` and `fill`; FileDrop `root` and `input`; IconButton and BareIconButton `root`; CopyButton `root`, `text` and `live`, with `tone` as its variant.
- MultiSelect has `root`, `panel`, `trigger`, `summary`, `chevron`, `search`, `bar`, `action`, `options`, `option`, `checkbox`, `icon`, `label` and `empty`.
- Menu has `menu` (the popover), `list`, `separator` and `item`; its `root` is the trigger, where a `class` string has always gone.
- Popover has `root` (the panel) and TooltipHost `root`; Toaster `root`, `live`, `toast`, `icon`, `message` and `dismiss`; SidePanel `root`, `head`, `title`, `body` and `footer`; CollapsibleSection `root`, `summary`, `title`, `meta`, `chevron` and `body`; Widget `root`, `head` and `title`.
- Meter has `root` and `fill` (its `fillClass` still works); BarList `root`, `row`, `label`, `value`, `track` and `fill`, `root` being the empty message too; ChipGroup `root`, `chip`, `input`, `label` and `icon`; SaveForm `root`, `grid`, `bar`, `status` and `actions`.
- CommandPalette has `root`, `search`, `input`, `list`, `heading`, `option`, `text`, `label`, `snippet`, `more`, `group`, `empty` and `count`; FormDialog `root` (the Dialog), `footer`, `actions` and `form`; ContactForm `root`, `consent`, `box`, `boxInput`, `boxLabel`, `issues` and `issue`.
- ConfirmDelete has `root` (the trigger, where `class` has always gone), `armed` and `message`.
- Tabs has `root`, `list`, `tab`, `icon` and `panel`; TabNav `root` and `link`; SiteNav `root`, `toggle`, `menuIcon`, `closeIcon`, `list`, `link` and `icon`; AppHeader `root`, `brand`, `nav` (its SiteNav) and `end`; Pagination `root`, `step`, `gap` and `page`.
- SplitLayout has `root`, `sidebar`, `sidebarHead`, `sidebarTitle`, `sidebarBody`, `list`, `listHead`, `resizer`, `detail` and `detailHead`; TreeView `root`, `item`, `toggle`, `icon` and `label`; LoadMore `root`, `failed` and `loading`; VirtualList `root`.
- BarChart has `root` (the empty message too), `plot`, `grid`, `tick`, `columns`, `column`, `bar`, `axis`, `axisLabel`, `legend`, `legendItem` and `key`.
- LineChart has `root`, `frame`, `plot`, `cursor`, `dot`, `band`, `overlay`, `tooltip`, `tooltipLabel`, `tooltipRow`, `tooltipName`, `tooltipValue`, `swatch`, `data`, `hint`, `legend`, `legendItem` and `key`; ScatterChart `root` (the empty message too), `axisLabel`, `plot`, `grid`, `tick`, `guide`, `corner` and `dot`; ContributionGraph `root`, `month` and `cell`.
- Carousel has `root`, `viewport`, `slide`, `image`, `controls`, `step`, `dot` and `pause`; Masonry `root`; MediaGallery `root` (the empty message too), `stage`, `frame`, `zoom`, `step`, `counter`, `caption`, `strip`, `thumb`, `thumbImage`, `play`, `lightbox`, `full` and `close`; ImageCropper `root`, `stage`, `image`, `crop`, `gridCols`, `gridRows` and `handle`.
- ZoomPane has `root`, `plate` and `tools`; QrCode, SiteFavicon (`root`, `img`, `icon`), Icon and WhenVisible `root`; IconPicker `root`, `search`, `grid`, `option`, `empty`, `bar`, `selection`, `clear`, `error` and `more`; MarkdownEditor `wrap`, `grid`, `root` (the textarea), `bar` and `barFailed`.
- Accordion `root`; Skeleton `root`, `block` and `label`; Progress `root` and `fill`; Breadcrumb `root`, `list`, `more`, `item`, `link` and `text`; RadioGroup `root`, `radio`, `choice`, `input`, `label` and `description`; MarkdownEditor's preview `root`, `failed` and `body`, its `previewClass` string landing on `body`.

<Callout type="warning">

A page can pass a Dialog or a Popover its content. A layout, or a page with a `--- server` fence, cannot pass a function or a block with parameters, such as a Table's `@cell`, but can pass an action. Put those in a component of yours, which then renders as an island.

</Callout>

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
    sidePanel: { closeLabel: 'Fermer' },
    pagination: { previousLabel: 'Précédent', nextLabel: 'Suivant' },
    table: { rowCount: { one: '{count} ligne', other: '{count} lignes' } },
  },
})
```

Your own key wins over the French kayjs-ui ships, and a prop you pass to one component still replaces the message for that component. The months and days a chart draws follow the page's locale too.

<ReadMore href="/llms/kayjs-ui-words">Every `ui.*` key and its English is in the full kayjs-ui reference.</ReadMore>

## Components

Actions: [Button](/ui/button), [IconButton](/ui/icon-button), [BareIconButton](/ui/bare-icon-button), [ConfirmDelete](/ui/confirm-delete), [CopyButton](/ui/copy-button), [Menu](/ui/menu), [Toggle](/ui/toggle).

Overlays: [Dialog](/ui/dialog), [FormDialog](/ui/form-dialog), [SidePanel](/ui/side-panel), [Popover](/ui/popover), [TooltipHost](/ui/tooltip-host), [Toaster](/ui/toaster), [CommandPalette](/ui/command-palette).

Forms: [FormField](/ui/form-field), [SaveForm](/ui/save-form), [ContactForm](/ui/contact-form), [TextInput](/ui/text-input), [Checkbox](/ui/checkbox), [ChipGroup](/ui/chip-group), [RadioGroup](/ui/radio-group), [Select](/ui/select), [MultiSelect](/ui/multi-select), [Combobox](/ui/combobox), [Textarea](/ui/textarea)

More inputs: [RangeInput](/ui/range-input), [Slider](/ui/slider), [FileDrop](/ui/file-drop), [IconPicker](/ui/icon-picker), [MarkdownEditor](/ui/markdown-editor), [ImageCropper](/ui/image-cropper), [Rating](/ui/rating).

Dates and times: [DateInput](/ui/date-input), [DateRangeInput](/ui/date-range-input), [TimeInput](/ui/time-input).

Layout: [Card](/ui/card), [CardRow](/ui/card-row), [PageHeader](/ui/page-header), [PageSection](/ui/page-section), [CollapsibleSection](/ui/collapsible-section), [Widget](/ui/widget), [SplitLayout](/ui/split-layout), [EmptyState](/ui/empty-state), [Notice](/ui/notice), [Masonry](/ui/masonry).

Navigation: [Tabs](/ui/tabs), [TabNav](/ui/tab-nav), [Breadcrumb](/ui/breadcrumb), [Segmented](/ui/segmented), [SiteNav](/ui/site-nav), [AppHeader](/ui/app-header), [Pagination](/ui/pagination), [Steps](/ui/steps), [TreeView](/ui/tree-view).

Data: [Table](/ui/table), [Stat](/ui/stat), [Meter](/ui/meter), [BarList](/ui/bar-list), [Badge](/ui/badge), [Avatar](/ui/avatar), [LineChart](/ui/line-chart), [BarChart](/ui/bar-chart), [ScatterChart](/ui/scatter-chart), [ContributionGraph](/ui/contribution-graph), [QrCode](/ui/qr-code), [SiteFavicon](/ui/site-favicon), [Icon](/ui/icon).

Media: [MediaGallery](/ui/media-gallery), [Carousel](/ui/carousel), [ZoomPane](/ui/zoom-pane), [WhenVisible](/ui/when-visible), [LoadMore](/ui/load-more), [VirtualList](/ui/virtual-list).

Drag and drop (`Sortable`, `Board`, `DropTargets`) comes from `@kaynooo/kayjs-ui/dnd` and is in the full reference. A move by arrow key is said to screen readers: where the item landed, as `Moved to 2 of 3`. A handle with no label or text of its own is named `Reorder` and the item's label or text, such as `Reorder Milk`, without the text of the buttons beside it, and it follows the item's text when that changes; give it an `aria-label` to say more.

<ReadMore href="/llms/kayjs-ui">Every component's props, forms with FormDialog, drag and drop, label translation and testing are in the full kayjs-ui reference.</ReadMore>

## Reference

Topics of the kayjs-ui reference the sections above do not link:

- [Setup, settings and testing](/llms/kayjs-ui-setup)
- [Icons, buttons, toasts, dialogs, cards, popovers and stats](/llms/kayjs-ui-basics)
- [Inputs, selects, editors and forms](/llms/kayjs-ui-forms)
- [Forms, FormDialog and Steps](/llms/kayjs-ui-forms-and-steps)
- [Tables, tabs, pagination, page layout, command palette and trees](/llms/kayjs-ui-tables-navigation-and-layout)
- [Charts, drag and drop, galleries and image tools](/llms/kayjs-ui-charts-drag-and-media)

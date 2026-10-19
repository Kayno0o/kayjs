---
title: kayjs-ui
order: 3
description: A set of kay components styled by one theme you restyle from your own stylesheet.
---
`@kaynooo/kayjs-ui` is a set of `.kay` components that your app compiles as its own, styled by the classes of one `theme.css`. Components use only `kui-` prefixed classes, so they never meet your own.

## Install

```sh
bun add @kaynooo/kayjs-ui @iconify-json/tabler
```

The `@kaynooo` scope must point at the Forgejo registry. A project made by `kay new` already has it in its `.npmrc`; for another, see [Installation](/getting-started/installation).

kay and Tailwind v4 are peers, and the default icons are Tabler's. kayjs-ui is released with kay, at kay's own version, and peers on kay's minor. Install the one matching your kay and move them together.

An app on a `^0.x` range moves to kay's version by hand, as a caret on 0.x never reaches it.

## Theme

`src/app.css` imports the theme right after Tailwind. Override any token in your own `@theme`.

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

A few tokens shape boxes rather than colour them, such as `--kui-border-card` for every hairline. A brutalist skin sets `--kui-shadow-raised` (under cards, rows, widgets and toasts), `--kui-shadow-press` (under framed buttons) and `--kui-press-travel` (how far a pressed button moves down). All three draw nothing by default.

### Light or dark

The theme is dark unless the visitor's system asks for light. `data-theme="light"` or `"dark"` on `html` wins over both. A site in one theme sets it in its root layout's `head` block.

```kay
head
  html(data-theme="light")
slot
```

### Toaster and tooltips

Render one `Toaster` and one `TooltipHost` in the root layout, `src/routes/_layout.kay`.

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

Import each component by its `.kay` path. Types, `toast`, `attempt`, `editing` and `infiniteList` come from the package itself.

```kay
---
import { toast } from '@kaynooo/kayjs-ui'
import Button from '@kaynooo/kayjs-ui/button.kay'

const save = () => toast.success('Saved')
---
Button(label="Save" tone="accent" onClick={save})
```

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
import type { Settings } from '@kaynooo/kayjs-ui'
import { defaults } from '@kaynooo/kayjs-ui'
import close from '~icons/tabler/circle-x'

const settings: Settings = { ...defaults, icons: { ...defaults.icons, close } }

export default settings
```

## Languages

The words a component shows by default, `Close`, `Cancel`, `Loading…`, are looked up in your messages before their English. Word them once in `src/messages/<locale>.ts` under `ui`, named for the component and the prop, and every instance reads them.

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

A prop you pass to one component still replaces the message for that component. The months and days a chart draws follow the page's locale too.

<ReadMore href="/llms/kayjs-ui">Every `ui.*` key and its English is in the full kayjs-ui reference.</ReadMore>

## Components

Actions: [Button](/ui/button), [IconButton](/ui/icon-button), [ConfirmDelete](/ui/confirm-delete), [CopyButton](/ui/copy-button), [Menu](/ui/menu), [Toggle](/ui/toggle).

Overlays: [Dialog](/ui/dialog), [FormDialog](/ui/form-dialog), [SidePanel](/ui/side-panel), [Popover](/ui/popover), [TooltipHost](/ui/tooltip-host), [Toaster](/ui/toaster), [CommandPalette](/ui/command-palette).

Forms: [FormField](/ui/form-field), [SaveForm](/ui/save-form), [ContactForm](/ui/contact-form), [TextInput](/ui/text-input), [Checkbox](/ui/checkbox), [ChipGroup](/ui/chip-group), [Select](/ui/select), [MultiSelect](/ui/multi-select), [Textarea](/ui/textarea), [RangeInput](/ui/range-input), [FileDrop](/ui/file-drop), [IconPicker](/ui/icon-picker), [MarkdownEditor](/ui/markdown-editor), [ImageCropper](/ui/image-cropper), [Rating](/ui/rating).

Layout: [Card](/ui/card), [CardRow](/ui/card-row), [PageHeader](/ui/page-header), [PageSection](/ui/page-section), [CollapsibleSection](/ui/collapsible-section), [Widget](/ui/widget), [SplitLayout](/ui/split-layout), [EmptyState](/ui/empty-state), [Notice](/ui/notice), [Masonry](/ui/masonry).

Navigation: [Tabs](/ui/tabs), [TabNav](/ui/tab-nav), [Segmented](/ui/segmented), [SiteNav](/ui/site-nav), [Pagination](/ui/pagination), [TreeView](/ui/tree-view).

Data: [Table](/ui/table), [Stat](/ui/stat), [Meter](/ui/meter), [BarList](/ui/bar-list), [Badge](/ui/badge), [Avatar](/ui/avatar), [LineChart](/ui/line-chart), [ScatterChart](/ui/scatter-chart), [ContributionGraph](/ui/contribution-graph), [QrCode](/ui/qr-code), [SiteFavicon](/ui/site-favicon), [Icon](/ui/icon).

Media: [MediaGallery](/ui/media-gallery), [Carousel](/ui/carousel), [ZoomPane](/ui/zoom-pane), [WhenVisible](/ui/when-visible), [LoadMore](/ui/load-more).

Drag and drop (`Sortable`, `Board`, `DropTargets`) comes from `@kaynooo/kayjs-ui/dnd` and is in the full reference. A move by arrow key is said to screen readers: where the item landed, as `Moved to 2 of 3`.

<ReadMore href="/llms/kayjs-ui">Every component's props, forms with FormDialog, drag and drop, label translation and testing are in the full kayjs-ui reference.</ReadMore>

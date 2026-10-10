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

The `@kaynooo` scope must point at the Forgejo registry in your `.npmrc`. kay and Tailwind v4 are peers, and the default icons are Tabler's.

## Theme

`src/app.css` imports the theme right after Tailwind. Override any token in your own `@theme`:

```css
@import 'tailwindcss';
@import '@kaynooo/kayjs-ui/theme.css';
@source '../.kay/classes.txt';

@theme {
  --color-kui-accent: light-dark(#3b6fd4, #7aa2f7);
}
```

Colours are `--color-kui-<name>`, used as `bg-kui-<name>`, and hold `light-dark(light, dark)`. The theme is dark unless the visitor's system asks for light, and `data-theme="light"` or `"dark"` on `html` wins over both.

Render one `Toaster` and one `TooltipHost` in the root layout, `src/routes/_layout.kay`:

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

Import each component by its `.kay` path. Types, `toast` and `attempt` come from the package itself:

```kay
---
import { toast } from '@kaynooo/kayjs-ui'
import Button from '@kaynooo/kayjs-ui/button.kay'

const save = () => toast.success('Saved')
---
Button(label="Save" variant="accent" onClick={save})
```

<Callout type="warning">

A page can pass a Dialog or a Popover its content, but a layout or a page with a `--- server` fence cannot pass a function or a block with parameters, such as a Table's `@cell`: put those in a component of yours, which then renders as an island.

</Callout>

## Settings

Icons are slots (`close`, `delete`, `search`, ...) mapped to any icon set. Replace some in your own settings module:

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

## Components

Actions: [Button](/ui/button), [IconButton](/ui/icon-button), [ConfirmDelete](/ui/confirm-delete), [CopyButton](/ui/copy-button), [Menu](/ui/menu), [Toggle](/ui/toggle).

Overlays: [Dialog](/ui/dialog), [FormDialog](/ui/form-dialog), [SidePanel](/ui/side-panel), [Popover](/ui/popover), [TooltipHost](/ui/tooltip-host), [Toaster](/ui/toaster), [CommandPalette](/ui/command-palette).

Forms: [FormField](/ui/form-field), [TextInput](/ui/text-input), [Select](/ui/select), [MultiSelect](/ui/multi-select), [RangeInput](/ui/range-input), [FileDrop](/ui/file-drop), [IconPicker](/ui/icon-picker), [MarkdownEditor](/ui/markdown-editor), [ImageCropper](/ui/image-cropper), [Rating](/ui/rating).

Layout: [Card](/ui/card), [CardRow](/ui/card-row), [PageSection](/ui/page-section), [CollapsibleSection](/ui/collapsible-section), [Widget](/ui/widget), [SplitLayout](/ui/split-layout), [EmptyState](/ui/empty-state), [Masonry](/ui/masonry).

Navigation: [Tabs](/ui/tabs), [TabNav](/ui/tab-nav), [Segmented](/ui/segmented), [SiteNav](/ui/site-nav), [Pagination](/ui/pagination).

Data: [Table](/ui/table), [Stat](/ui/stat), [Meter](/ui/meter), [BarList](/ui/bar-list), [Badge](/ui/badge), [LineChart](/ui/line-chart), [ScatterChart](/ui/scatter-chart), [ContributionGraph](/ui/contribution-graph), [QrCode](/ui/qr-code), [SiteFavicon](/ui/site-favicon), [Icon](/ui/icon).

Media: [MediaGallery](/ui/media-gallery), [Carousel](/ui/carousel), [ZoomPane](/ui/zoom-pane), [WhenVisible](/ui/when-visible).

Drag and drop (`Sortable`, `Board`, `DropTargets`) comes from `@kaynooo/kayjs-ui/dnd` and is in the full reference.

<ReadMore href="/llms/kayjs-ui">Every component's props, forms with FormDialog, drag and drop, label translation and testing are in the full kayjs-ui reference.</ReadMore>

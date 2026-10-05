# kayjs-ui

kay components for the user's sites, ported from `@kaynooo/svelte` and `@kaynooo/solidjs`: buttons and icons, toasts, dialogs and a form dialog calling a page's action, a sortable table, switches, inputs, cards, badges, popovers and tooltips, layouts, a command palette, charts, drag and drop, media, and a carousel, a rating and a site menu for marketing pages. They are `.kay` sources the app compiles as its own, styled by one `theme.css` the app restyles from its own stylesheet.

## Install

kayjs-ui is published to the Forgejo registry at git.kaynooo.fr, beside kay. Tell Bun where the `@kaynooo` scope lives once, in `~/.bunfig.toml` (a project made by `kay new` already carries it in its `.npmrc`):

```toml
[install.scopes]
"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"
```

```sh
bun add @kaynooo/kayjs-ui @iconify-json/tabler
```

kay 0.6 or later and Tailwind v4 are peers. Two more are optional, installed only by an app using what needs them: `chartist` for LineChart, and `hls.js` for MediaGallery to play `.m3u8` playlists in browsers without native HLS.

## Theme

The stylesheet the root layout imports brings the theme in right after Tailwind. kay collects the classes of the library's templates with the app's own, so no `@source` points into `node_modules`:

```css
/* src/app.css */
@import 'tailwindcss';
@import '@kaynooo/kayjs-ui/theme.css';
@source '../.kay/classes.txt';

@theme {
  --color-kui-accent: light-dark(#3b6fd4, #7aa2f7);
}
```

- Every class and token is prefixed `kui-`, so a site's own `btn`, `card` or `--color-accent` never meets them. A rule on `.kui-btn` restyles every button; utilities passed through a component's `class` prop restyle one.
- The tokens are `@theme default`, so the app's `@theme` overrides any of them. Each colour is `--color-kui-<name>`, used as `bg-kui-<name>` and the like, and holds `light-dark(light, dark)`.
- The theme is dark unless the visitor's system asks for light. `data-theme="light"` or `data-theme="dark"` on `html` wins over both, for a site with its own switch, and on any element it themes what that element holds.

## A first component

The root layout renders the toasts and tooltips once:

```kay
---
import Toaster from '@kaynooo/kayjs-ui/toaster.kay'
import TooltipHost from '@kaynooo/kayjs-ui/tooltip-host.kay'
import './app.css'
---
slot
Toaster
TooltipHost
```

A component with an `on*` handler is an island, so it runs in the browser, where a toast shows:

```kay
---
import Button from '@kaynooo/kayjs-ui/button.kay'
import { toast } from '@kaynooo/kayjs-ui'
---
Button(label="Save" variant="accent" icon="plus" onClick={() => toast.success('Saved')})
```

## Develop

`bun run test` runs the server tests, then the DOM tests on happy-dom, against the fixture app in `tests/fixture`. `bun run check` and `bun run lint` check the rest.

The full reference, written for people and coding agents alike, is [llms.txt](llms.txt).

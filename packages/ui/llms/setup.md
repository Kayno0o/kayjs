# kayjs-ui: Setup, settings and testing

## Common tasks

### Setup

kayjs-ui is published as `@kaynooo/kayjs-ui` to `https://git.kaynooo.fr/api/packages/kaynooo/npm/`, beside kay. kay, Tailwind v4 and `@iconify-json/tabler` are peer dependencies. It is released with kay at its version and peers on kay's minor: the app installs the one matching its kay and moves them together.

```sh
kay add ui
```

It installs the package and `@iconify-json/tabler` (needing Tailwind in the app) and lists `ui()` from `@kaynooo/kayjs-ui/extension` in `extensions` in kay.config.ts. That one line brings the theme, a `Toaster` and a `TooltipHost` on every page, outside the app's layouts, so no layout or stylesheet names them. Doing it by hand, `bun add @kaynooo/kayjs-ui @iconify-json/tabler` and add `ui()`. The extension's stylesheet comes before the app's, so the app's own `@theme` overrides win.

Three peers are optional, installed only when used: `chartist` for `LineChart`, `leaflet` for `MapView`, `hls.js` for an `.m3u8` video in a browser without native HLS.

`ui()` is the whole setup. An app writing the theme itself, as before, still works: `src/app.css`, imported by the root `_layout.kay`, imports it right after Tailwind. kay collects the classes of the library's templates along with the app's own, so no `@source` line has to point into `node_modules`:

```css
@import 'tailwindcss';
@import '@kaynooo/kayjs-ui/theme.css';

@theme {
  --color-accent: light-dark(#3b6fd4, #7aa2f7);
}
```

kay leaves out the theme's rules for the `kui-` classes no file of the app or component it renders writes whole, so an app ships the CSS of the components it uses; a class put together at runtime, or written only in a CMS body, is kept by writing it whole in any file of the app, for instance in a comment in `app.css` (see Using a component library in kay's `llms/component-libraries.md`).

`@apply` of a theme utility (`@apply bg-popover`) in a stylesheet of the app builds with `ui()` alone: kay adds an `@reference` of the theme after its Tailwind import for you, which brings the tokens and writes no rule, so the theme is not loaded twice. An `@reference '@kaynooo/kayjs-ui/theme.css';` the app already writes stays harmless. An app without `ui()` writes that line itself, or the build fails with `Cannot apply unknown utility class`.

The theme's tokens are `@theme default` and carry the app's own names, so one theme feeds the app and the library, the app's `@theme` overrides any of them wherever it sits, and the utilities are the app's too (`bg-surface`, `text-muted`, `border-border`). Each colour holds `light-dark(light, dark)`. Eight are seeds a skin sets alone: `--color-background`, `--color-foreground`, `--color-accent`, `--color-success`, `--color-warning`, `--color-info`, `--color-danger` and `--color-input`; every other colour derives from them with `color-mix` (`surface` is the background with 3% of the foreground, `muted` the foreground with 30% of the background), in both schemes, so `@theme { --color-background: ...; --color-foreground: ...; ... }` with those eight reskins everything. A derived colour stays overridable on its own. A seed must read at 4.5:1 on `popover` and `surface-strong`, the deepest grounds (`input` at 3:1); a skin with one scheme writes its seeds once and sets `color-scheme` on `:root` to it, as `accent-hover` shades by the scheme. Set the seeds where the theme is computed, `:root` or `html` (`[data-theme=x]` on `html` too): a seed scoped to a subtree does not re-derive the colours inside it.

- `--color-background` falls back to the app's `--color-base`, `--color-foreground` to `--color-text` and `--color-danger` to `--color-error`, so an app built from kay's template needs no extra line. An app that already sets `--color-accent`, `--color-muted`, `--color-surface`, `--color-border` or a `--radius-*` for its own use drives kayjs-ui with them, which is intended; an app on shadcn names, where `accent` and `muted` are hover and fill colours, sets these two itself.
- Surfaces, deepest first: `popover` (lists, menus, dialogs, wells), `background`, `surface` (fields, cards, buttons), `surface-strong` (notices, avatars, tooltips, tracks, the selected item).
- Hairlines: `border` and `border-strong` (frames of buttons and shells). Text: `foreground` and `muted` (quiet text, placeholders). `hover` is the fill of a hovered row, option or ghost button.
- State: `accent`, `accent-hover`, `accent-foreground` (text on it, a solid badge's too), `success`, `warning`, `info` and `danger`. Series: `chart-1` to `chart-6`.
- Fields: `input`, the solid border of a text field, which buttons, Toggle tracks, carousel dots and empty Rating stars draw too, at 3:1 on every surface, so an app changing its surfaces sets it to match; and `ring`, the border of a focused field, `accent` unless set.
- Corners are Tailwind's own `--radius-sm` (Badge, a thumb), `--radius-md` (buttons, fields, chips, a Toggle's track) and `--radius-lg` (cards, dialogs, popovers, notices, toasts), and an Avatar is `rounded-full`; an app that wants square corners sets all three to `0`. Also read as they are: `--font-mono`, `--font-weight-*`, `--spacing`, `--text-xs` and `--text-sm`.
- Type: `--text-2xs` (0.6rem, the micro text), `--tracking-label` (0.15em, the one tracking of labels, headings and actions).
- `--border-width`, `1px` by default and registered as a `<length>`, is the keyline of every framed box: Button, Card and its head, CardRow, Widget, Notice, Avatar, Badge, text fields, toasts, Dialog, SidePanel, CommandPalette, popovers, tooltips, Table, a boxed CollapsibleSection, SaveForm's bar, Segmented, FileDrop, Pagination's steps, SiteNav's open list, chart tooltips, ChipGroup's chips, IconPicker's grid, the ScatterChart plot, ImageCropper's stage, Toggle's track and Table's filter and selection bars. The crop frame and handles keep fixed borders, as they show over any photo. A value that is no length, such as `2px solid red`, is dropped.
- `--label-case` is `uppercase` by default (`none` for sentence case) for buttons, headings, table heads and other labels, and `--font-label` their font, the text's own unless set, such as `var(--font-mono)`.
- `--density`, `1` by default, multiplies the card, inline and section gaps and the field insets, so `0.75` packs a whole app tighter.
- `--shadow-raised` (under a Card, CardRow, Widget and toast) and `--shadow-press` (under a Button and a framed IconButton, which move down by `--press-travel` and drop that shadow while pressed) are `none` and `0px` by default. A brutalist skin: `--shadow-raised: 4px 4px 0 var(--color-foreground)`, `--shadow-press: 3px 3px 0 var(--color-foreground)`, `--press-travel: 3px`.
- `--shell-line` and `--shell-fill` are the hairline and the fill of a Button, a framed IconButton and a stat badge, redeclared by the tones, the hover and the ghost forms in `theme.css`. Set them as utilities on the part so the app's value wins, with `hover:` for the hovered look: `Button: { parts: { root: '[--shell-line:var(--color-accent)] hover:[--shell-fill:transparent]' } }` (the `space` skin's hairline key is this).
- A knob only one component reads is no token: restyle that component everywhere in `src/ui.ts` (`Badge: { parts: { root: 'uppercase font-mono tracking-wider border-2' } }`) and one instance through `class`. A per-instance length is set on it, as `class="[--table-height:50vh]"`, `--chart-height` for a LineChart, BarChart or ScatterChart, `--zoom-scale` for a ZoomPane.
- Skins: `@import '@kaynooo/kayjs-ui/skins/brutalist.css';`, `soft.css` or `space.css` after `theme.css` sets a whole look (brutalist: black and white, 2px keylines, square corners, offset shadows, monospace capitals; soft: sentence case and a faint shadow; space: dark only, near-black background, starlight accent, Space Grotesk, no keylines on boxes, buttons as hairline keys lit in the accent on hover, drawn checkboxes, themed selects, and a `starfield` background utility of tiled dots). The default theme stays for an app importing none. `space.css` names the family `Space Grotesk`: serve it with `fonts: [{ fontsource: '@fontsource-variable/space-grotesk' }]`. Your own `@theme` after the import wins.
- Where a skin's import goes: after `theme.css`, or with `ui()` (which injects the theme before the app's CSS) after `@import 'tailwindcss'` in `src/app.css`. What each sets besides the eight seeds, so an override of yours knows what it changes: `soft` sets `--label-case: none`, `--tracking-label: 0.02em` and `--shadow-raised`; `brutalist` sets `--border-width: 2px`, the three `--radius-*` to `0`, `--font-label`, `--shadow-raised`, `--shadow-press` and `--press-travel`; `space` sets `--font-sans`, `--color-popover`, `--color-surface`, `--color-surface-strong`, `--color-border`, `--color-border-strong`, `--border-width: 0px` (put back to `1px` on buttons, fields, chips, toggles, badges, notices, avatars, segmented controls, file drops and pagination steps), `--label-case: none`, `--tracking-label`, `color-scheme: dark` on `:root` and `[data-theme]`, `border-color: var(--color-input)` on Segmented and FileDrop and `--_control-line` on pagination steps, unchecked chips, Segmented and FileDrop, a `box-shadow` under overlays, drawn checkboxes (accent border on hover), and themed selects (a chevron, and with `appearance: base-select` the `::picker(select)` list and its options). It also sets the key look (`--shell-line`, `--shell-fill`, accent on hover) on `.kui-btn` and a framed `.kui-icon-btn`, except tone, ghost, inline, pressed and disabled buttons, which keep the theme's look; a keyboard-focused button shows the theme's focus hairline and outline.
- A skin's rules sit at one class of specificity or none (the key's hover at two, as the theme's own), so an app rule in `@layer components` with one class beats them, and unlayered CSS and `ui.ts` part classes (utilities layer) already did. `starfield` is a `background-image` of four dots with their sizes, over `--color-background`, fixed to the viewport. `class="starfield bg-surface"` changes the ground. A `bg-[radial-gradient(...)]` or `bg-linear-to-b` utility replaces the dots, and the four-value `background-size` then applies to your image: for a fuller sky, write your own `background-image` list that repeats the dots and adds your gradients, with its own `background-size`.

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

The extension puts both islands on every page, so each page loads the hydration code, and since the Toaster holds state `kay build` does not keep a page prerendered under it.

### Settings

The icons the components draw come from slots, each named for what it means: `alert`, `apps`, `back`, `bell`, `calendar`, `chat`, `chevron`, `close`, `collapse`, `delete`, `edit`, `expand`, `external`, `globe`, `info`, `menu`, `pause`, `play`, `plus`, `refresh`, `search`, `send`, `spinner`, `star`, `stop`, `success`, `trendDown`, `trendFlat`, `trendUp`, `zoomFit`, `zoomIn`, `zoomOut`. The app replaces any of them through kay's library settings, spreading the defaults:

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

`kay check` checks this module against `UiSettings`; the server, the browser, `kay build` and `bun test` all render with it.

### Restyle a component

See [Restyle a component](restyle.md): `class` as a string or an object of parts, `src/ui.ts`, the recipes and the contract every component keeps.

### Copy a component into the app

When a recipe cannot express the change, `kay ui eject card` copies `card.kay` into `src/components/ui/`, with the files only it uses, and points the imports of `@kaynooo/kayjs-ui/card.kay` in the app's `src/`, `tests/` and root `.ts` files (`kay.config.ts`) at the copy. Edit the copy; the theme, the `ui.*` messages and the other components stay the library's.

- Files other components share (`icon.kay`, `defaults.ts`) stay in the library, and the copy imports them as `@kaynooo/kayjs-ui/icon.kay` and `@kaynooo/kayjs-ui/lib/defaults` (`lib/` is for copies and not a stable API). Another public component the copy uses stays upstream too: eject it separately.
- kayjs-ui's own components keep the library's version of what they use (`FormDialog` uses the library's `Dialog`); the command lists them.
- An entry of `src/ui.ts` keyed by the import path is repeated under the copy's path, so the copy and the library's own users keep the app's look; one keyed by the name (`Card`) becomes the library's path key plus the copy's, as a name names two components after the copy.
- `src/components/ui/.upstream/` records the version and the library's text each copy came from, to commit with it. `--dry-run` writes nothing, and an ejected or existing file is refused.
- `kay ui diff [component]` prints what the library changed in each copy since that version, with the `git merge-file` line to merge it; `--check` exits 1 when anything changed, and `--accept` records the installed text once merged. It also reports a library file the copy imports but did not take (`defaults.ts`) that changed or went, which the copy cannot show. A damaged `.upstream/` record ends with a message naming the file.

### Testing an app's use of it

A page that uses the components renders them in `testSite()` like the app's own. To test what their handlers do, `mountComponent(Component, props)` from `kay/test` renders a component of the app into the DOM `kay/test/dom` registers, listed after `kay/test/preload` under `[test] preload` in bunfig.toml with `@happy-dom/global-registrator` installed; it shims the popover API happy-dom lacks, which Toaster and Popover use.

## Reference

- Import each component by its `.kay` path: `import Button from '@kaynooo/kayjs-ui/button.kay'`. Types, `toast`, `attempt`, `messageOf`, `editing`, `infiniteList` and the defaults come from the package itself: `import { toast } from '@kaynooo/kayjs-ui'`, and the drag and drop controllers from `@kaynooo/kayjs-ui/dnd`.
- The theme reads the app's own names (`--color-background`, `--color-foreground`, `--color-accent`, `--color-muted`, `--color-border`, `--radius-lg`, `--border-width`, `--density`...), so one `@theme` feeds the app and the library. The `kui-` names it used before 1.72 are gone since 1.75: [upgrading](../../../llms/upgrading.md) pairs each with its new name.

Components write no Tailwind utility, only the classes of `theme.css`, every one prefixed `kui-`, so a site's own `btn` or `card` never meets them, while the theme's tokens carry the app's own names (`--color-accent`, `--color-background`), so one theme feeds the app and the library. A rule of the app's on one of those classes restyles every instance, and `--border-width` sets the keyline of every framed box; utilities passed through a component's `class` prop restyle one, and `src/ui.ts` restyles the parts of a component with some, see [Restyle a component](#restyle-a-component).
- `toast` only shows in the browser, called from an island. The server's toast list, shared by every request, stays empty. `ui()` in kay.config.ts (`kay add ui`) mounts one `Toaster`, one `TooltipHost` and the theme on every page. An extension may render its own: while one is mounted, a second renders nothing until the first unmounts.

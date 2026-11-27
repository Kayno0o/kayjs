---
title: "@kayjs/ui (5 Style Grammars)"
description: Platform-first headless UI primitives and pure CSS @layer kui Style Grammars with zero JS styling runtime and one-file eject.
section: plugins
order: 1
---

`@kayjs/ui` pairs **platform-first headless TSX primitives** (zero-JS native HTML wherever the platform suffices: `<details name>`, `<dialog>`, `popover`, `<input type="checkbox">`) with **5 structurally distinct pure CSS `@layer kui` Style Grammars**.

<Callout title="Try all 5 grammars live" tone="tip">
Visit the interactive [UI Grammars sandbox](/grammars) to switch this site between **Orbit**, **Editorial**, **Workshop**, **Console**, **Soft**, and **Bare** in real time.
</Callout>

## Setup

```ts
// kay.config.ts
import { defineConfig } from '@kayjs/kay/config'
import { ui } from '@kayjs/ui/plugin'

export default defineConfig({
  plugins: [ui({ grammar: 'orbit' })],
})
```

Available grammars: `'orbit'` · `'editorial'` · `'workshop'` · `'console'` · `'soft'` · `'bare'`.

## Primitives

- **0 KB JS static & layout primitives**: `Stack`, `Cluster`, `Grid`, `Sidebar`, `Split`, `Button`, `Card` (`CardHeader`/`CardBody`/`CardFooter`), `Badge`, `Notice`, `Field`, `Switch`, `Checkbox`, `RadioGroup`, `Accordion` (`AccordionItem`), `Popover`, `Dialog`, `Drawer`.
- **Auto-hydrated interactive islands**: `ControlledDialog` and `ControlledDrawer` (a `Dialog` or `Drawer` your code opens and closes through an `open` signal), `Tabs`, `Menu`, `Select`, `CommandPalette` (`⌘K`), `DataTable` (sort, filter, select, paginate), `Toaster` + `toast()`.

`Dialog` and `Drawer` ship no JavaScript. Their trigger opens them with the browser's invoker commands (`commandfor` and `command="show-modal"`), and the browser closes them on Esc, on the close button and on a click on the backdrop (`closedby="any"`). A browser that lacks one of these, such as Safari before 26.2, loads a fallback of about 400 bytes that does their work; other browsers fetch nothing. The `ui()` plugin adds that check to pages with a `commandfor` button, so your own buttons get it too.

```tsx
import { Button, Card, CardBody, CardHeader, Switch } from '@kayjs/ui'

export default function Settings() {
  return (
    <Card>
      <CardHeader>Preferences</CardHeader>
      <CardBody>
        <Switch name="dark" label="Starry dark mode" checked />
        <Button tone="accent">Save</Button>
      </CardBody>
    </Card>
  )
}
```

## Eject & own your CSS

Because every grammar is a single pure CSS file wrapped in `@layer kui`, you can eject and customize it anytime — and Tailwind or your own stylesheet always wins without `!important`:

```bash
kay ui-eject orbit src/styles/ui.css
```

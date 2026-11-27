import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Signal } from '../src/reactivity/index'
import { build } from '../src/build/index'
import { testApp } from '../src/test/index'
import { ui } from '../../ui/src/plugin'

const UI_ENTRY = join(import.meta.dir, '../../ui/src/index.ts')
const STYLES_DIR = join(import.meta.dir, '../../ui/src/styles')
const GRAMMARS_DIR = join(STYLES_DIR, 'grammars')

const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

// ---- WCAG 2.1 contrast ratio math helpers ----

function parseHex(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, '')
  const full = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg)
  const l2 = relativeLuminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

function mixSrgb(fg: string, pct: number, bg: string): string {
  const p = pct / 100
  const [r1, g1, b1] = parseHex(fg)
  const [r2, g2, b2] = parseHex(bg)
  const hex = [r1 * p + r2 * (1 - p), g1 * p + g2 * (1 - p), b1 * p + b2 * (1 - p)]
    .map(v => Math.round(v).toString(16).padStart(2, '0'))
    .join('')
  return `#${hex}`
}

interface GrammarTokens {
  light: Record<string, string>
  dark: Record<string, string>
}

function parseRootTokens(css: string): GrammarTokens {
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\}/)
  if (!rootMatch)
    throw new Error('Could not find :root block')
  const body = rootMatch[1]!
  const light: Record<string, string> = {}
  const dark: Record<string, string> = {}

  const lightDarkRe = /(--[\w-]+)\s*:\s*light-dark\(\s*(#[0-9a-fA-F]{3,6})\s*,\s*(#[0-9a-fA-F]{3,6})\s*\)/g
  for (const m of body.matchAll(lightDarkRe)) {
    light[m[1]!] = m[2]!
    dark[m[1]!] = m[3]!
  }

  const singleHexRe = /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/g
  for (const m of body.matchAll(singleHexRe)) {
    light[m[1]!] = m[2]!
    dark[m[1]!] = m[2]!
  }

  return { light, dark }
}

// ---- Build a fixture app with all interactive UI primitives once so we can test both SSR and Happy-DOM ----

let builtDir = ''
let mountFn!: (container: Element, render: () => Node | DocumentFragment | null) => () => void
let signal!: <T>(initial: T) => Signal<T>
let toastApi!: {
  items: Signal<Array<{ id: string, title: string }>>
  show: (title: string, description?: string, durationMs?: number) => string
  dismiss: (id: string) => void
  clear: () => void
}
let uiMods: Record<string, (...args: any[]) => any> = {}
let ssrHtml = ''

beforeAll(async () => {
  builtDir = makeTemp('kay-audit-ui-')
  mkdirSync(join(builtDir, 'src/routes'), { recursive: true })
  mkdirSync(join(builtDir, 'src/components'), { recursive: true })

  // A tiny island that exposes `mount`, `signal`, `toast`, and an interactive Field+Select island from the exact same bundled client runtime.
  writeFileSync(join(builtDir, 'src/components/SigHost.tsx'), `
    import { signal } from '@kayjs/kay'
    import { mount } from '@kayjs/kay/internal/dom'
    import { ControlledDialog, ControlledDrawer, Field, Select, toast } from ${JSON.stringify(UI_ENTRY)}
    export function FieldIsland(props: { err: ReturnType<typeof signal<string | undefined>> }) {
      return (
        <Field id="isl-email" label="Email" hint="Work email" error={props.err.value} required>
          <input name="email" type="email" aria-describedby="extra-island" />
        </Field>
      )
    }
    export function FieldSelectIsland(props: { err: ReturnType<typeof signal<string | undefined>> }) {
      return (
        <Field id="isl-plan" label="Plan" hint="Pick a tier" error={props.err.value} required>
          <Select name="plan" options={[{ value: 'free', label: 'Free' }, { value: 'pro', label: 'Pro' }]} />
        </Field>
      )
    }
    ;(globalThis as Record<string, unknown>).__kayAuditTest = { mount, signal, toast, FieldIsland, FieldSelectIsland, ControlledDialog, ControlledDrawer }
    export function SigHost() {
      const s = signal(0)
      return <span>{s.value}</span>
    }
  `)

  writeFileSync(join(builtDir, 'src/routes/index.tsx'), `
    import { CommandPalette, DataTable, Dialog, Drawer, Field, Menu, Select, Toaster } from ${JSON.stringify(UI_ENTRY)}
    import { SigHost } from '../components/SigHost'

    export default async function AuditPage() {
      return (
        <main>
          <SigHost />
          <Field id="email" label="Email" hint="Use work email" required>
            <input id="email" name="email" type="email" />
          </Field>
          <Field id="username" label="Username" error="Already taken" required>
            <input name="username" type="text" aria-describedby="extra-note" />
          </Field>
          <Dialog title="Delete item" description="This cannot be undone." triggerLabel="Open">
            <p>Body</p>
          </Dialog>
          <Dialog title="" ariaLabel="Fallback dialog" triggerLabel="Open 2">
            <p>Body 2</p>
          </Dialog>
          <Drawer title="Filters" description="Narrow your results." triggerLabel="Open drawer">
            <p>Drawer body</p>
          </Drawer>
          <CommandPalette
            items={[
              { id: 'a', label: 'Alpha' },
              { id: 'b', label: 'Beta' },
            ]}
          />
          <Menu
            label="Actions"
            items={[
              { id: 'edit', label: 'Edit' },
              { id: 'del', label: 'Delete' },
            ]}
          />
          <Select
            ariaLabel="Plan"
            options={[
              { value: 'free', label: 'Free' },
              { value: 'pro', label: 'Pro' },
            ]}
          />
          <DataTable
            rows={[{ id: '1', name: 'Alice' }]}
            columns={[{ key: 'name', label: 'Name' }]}
          />
          <Toaster />
        </main>
      )
    }
  `)

  const plugins = [ui({ grammar: false })]
  const manifest = await build({ root: builtDir, plugins })
  const app = await testApp({ root: builtDir, plugins, prebuilt: true })
  ssrHtml = await (await app.get('/')).text()

  GlobalRegistrator.register()

  const loadIsland = async (exportName: string) => {
    const entry = Object.entries(manifest.islands).find(([k]) => k.endsWith(`#${exportName}`))
    if (!entry)
      throw new Error(`Missing built island chunk for ${exportName}: ${JSON.stringify(manifest.islands)}`)
    const modPath = join(builtDir, 'dist/client', entry[1].replace('/_kay/', ''))
    return await import(modPath)
  }

  await loadIsland('SigHost')
  const helpers = (globalThis as Record<string, unknown>).__kayAuditTest as {
    mount: typeof mountFn
    signal: typeof signal
    toast: typeof toastApi
    FieldIsland: (...args: any[]) => any
    FieldSelectIsland: (...args: any[]) => any
    ControlledDialog: (...args: any[]) => any
    ControlledDrawer: (...args: any[]) => any
  }
  mountFn = helpers.mount
  signal = helpers.signal
  toastApi = helpers.toast
  uiMods.FieldIsland = helpers.FieldIsland
  uiMods.FieldSelectIsland = helpers.FieldSelectIsland
  uiMods.ControlledDialog = helpers.ControlledDialog
  uiMods.ControlledDrawer = helpers.ControlledDrawer

  for (const name of ['Menu', 'Select', 'CommandPalette', 'DataTable', 'Toaster']) {
    const mod = await loadIsland(name)
    uiMods[name] = mod[name] ?? mod.default
  }
})

afterAll(() => {
  GlobalRegistrator.unregister()
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

function mountInBody(render: () => Node | DocumentFragment | null): { host: HTMLDivElement, dispose: () => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const dispose = mountFn(host, render)
  return {
    host,
    dispose: () => {
      dispose()
      host.remove()
    },
  }
}

describe('Box 20 — Menu, Select, CommandPalette keyboard & active-descendant accessibility', () => {
  it('Menu: unique IDs, conditional aria-controls, no aria-activedescendant on button, roving menuitem focus, ArrowDown/Up open, Home/End, skip disabled, Tab closes without preventing default', async () => {
    const picked: string[] = []
    const MenuComp = uiMods.Menu!
    const m1 = mountInBody(() => MenuComp({
      label: 'File actions',
      items: [
        { id: 'disabled-first', label: 'Locked', disabled: true },
        { id: 'open', label: 'Open' },
        { id: 'disabled-mid', label: 'Archived', disabled: true },
        { id: 'rename', label: 'Rename' },
        { id: 'delete', label: 'Delete' },
      ],
      onSelect: (id: string) => picked.push(id),
    }))
    const m2 = mountInBody(() => MenuComp({
      label: 'Edit actions',
      items: [{ id: 'copy', label: 'Copy' }],
    }))

    try {
      const trig1 = m1.host.querySelector<HTMLButtonElement>('[data-part="trigger"]')!
      const trig2 = m2.host.querySelector<HTMLButtonElement>('[data-part="trigger"]')!

      // Closed state: aria-controls is omitted (no dangling IDREF), aria-activedescendant is never set on role="button"
      expect(trig1.getAttribute('aria-controls')).toBeNull()
      expect(trig2.getAttribute('aria-controls')).toBeNull()
      expect(trig1.getAttribute('aria-activedescendant')).toBeNull()

      // Open menu 1 via click
      trig1.click()
      const menuEl = m1.host.querySelector<HTMLElement>('[role="menu"]')!
      expect(menuEl).toBeTruthy()
      const ctrl1 = trig1.getAttribute('aria-controls')
      expect(ctrl1).toBe(menuEl.id)
      // Must NOT place aria-activedescendant on <button aria-haspopup="menu">
      expect(trig1.getAttribute('aria-activedescendant')).toBeNull()

      // Menu has accessible name via aria-labelledby referencing trigger or aria-label
      const labelledBy = menuEl.getAttribute('aria-labelledby')
      const ariaLabel = menuEl.getAttribute('aria-label')
      expect(Boolean(labelledBy || ariaLabel)).toBe(true)
      if (labelledBy)
        expect(trig1.id).toBe(labelledBy)

      // Open menu 2 briefly to confirm unique menu IDs
      trig2.click()
      const ctrl2 = trig2.getAttribute('aria-controls')
      expect(ctrl2).toBeTruthy()
      expect(ctrl1).not.toBe(ctrl2)
      trig2.click()
      expect(trig2.getAttribute('aria-controls')).toBeNull()

      // Re-open menu 1 via ArrowDown when trigger is focused -> opens on first enabled item ('open', index 1)
      trig1.focus()
      trig1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      const openMenu = m1.host.querySelector<HTMLElement>('[role="menu"]')!
      expect(openMenu).toBeTruthy()
      expect(trig1.getAttribute('aria-controls')).toBe(openMenu.id)

      const items = [...openMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      expect(items.length).toBe(5)
      const ids = new Set(items.map(i => i.id))
      expect(ids.size).toBe(5)
      for (const item of items) {
        expect(item.id).toBeTruthy()
        expect(item.getAttribute('tabindex')).toBe('-1')
      }

      // First enabled item ('open', index 1) is highlighted and focused
      await Promise.resolve()
      expect(items[1]!.getAttribute('data-highlighted')).toBe('true')
      expect(document.activeElement?.id).toBe(items[1]!.id)

      // ArrowDown skips disabled item at index 2 -> lands on index 3 ('rename')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(items[3]!.getAttribute('data-highlighted')).toBe('true')
      expect(document.activeElement?.id).toBe(items[3]!.id)

      // End jumps to last enabled item (index 4, 'delete')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      expect(items[4]!.getAttribute('data-highlighted')).toBe('true')
      expect(document.activeElement?.id).toBe(items[4]!.id)

      // Home jumps to first enabled item (index 1, 'open')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
      expect(items[1]!.getAttribute('data-highlighted')).toBe('true')
      expect(document.activeElement?.id).toBe(items[1]!.id)

      // Tab closes the menu WITHOUT preventing default (does not trap focus), and removes aria-controls
      const tabEvt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      document.dispatchEvent(tabEvt)
      expect(tabEvt.defaultPrevented).toBe(false)
      expect(m1.host.querySelector('[role="menu"]')).toBeNull()
      expect(trig1.getAttribute('aria-controls')).toBeNull()

      // ArrowUp on focused closed trigger opens on last enabled item ('delete', index 4), Enter selects it
      trig1.focus()
      trig1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
      const items2 = [...m1.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      expect(items2[4]!.getAttribute('data-highlighted')).toBe('true')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      expect(picked).toEqual(['delete'])
      expect(m1.host.querySelector('[role="menu"]')).toBeNull()
      expect(trig1.getAttribute('aria-controls')).toBeNull()
    }
    finally {
      m1.dispose()
      m2.dispose()
    }
  })

  it('Select: unique IDs, conditional aria-controls, aria-activedescendant, ArrowDown/Up open, accessible listbox name, tabindex=-1, Home/End, Tab closes without preventing default', () => {
    const changes: string[] = []
    const SelectComp = uiMods.Select!
    const s1 = mountInBody(() => SelectComp({
      ariaLabel: 'Billing plan',
      defaultValue: 'pro',
      options: [
        { value: 'free', label: 'Free' },
        { value: 'pro', label: 'Pro' },
        { value: 'enterprise', label: 'Enterprise' },
      ],
      onChange: (v: string) => changes.push(v),
    }))
    const s2 = mountInBody(() => SelectComp({
      ariaLabel: 'Region',
      options: [{ value: 'eu', label: 'Europe' }],
    }))

    try {
      const trig1 = s1.host.querySelector<HTMLButtonElement>('[data-part="trigger"]')!
      const trig2 = s2.host.querySelector<HTMLButtonElement>('[data-part="trigger"]')!

      // Closed state: aria-controls omitted (no dangling IDREF)
      expect(trig1.getAttribute('aria-controls')).toBeNull()
      expect(trig2.getAttribute('aria-controls')).toBeNull()
      expect(trig1.getAttribute('aria-activedescendant')).toBeNull()

      // ArrowDown on focused closed trigger opens listbox
      trig1.focus()
      trig1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      const listbox = s1.host.querySelector<HTMLElement>('[role="listbox"]')!
      expect(listbox).toBeTruthy()
      const ctrl1 = trig1.getAttribute('aria-controls')
      expect(ctrl1).toBe(listbox.id)
      expect(Boolean(listbox.getAttribute('aria-label') || listbox.getAttribute('aria-labelledby'))).toBe(true)

      // Open s2 to verify unique listbox IDs
      trig2.click()
      const ctrl2 = trig2.getAttribute('aria-controls')
      expect(ctrl2).toBeTruthy()
      expect(ctrl1).not.toBe(ctrl2)
      trig2.click()
      expect(trig2.getAttribute('aria-controls')).toBeNull()

      // Re-open s1 via ArrowUp
      trig1.focus()
      trig1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
      const listbox1 = s1.host.querySelector<HTMLElement>('[role="listbox"]')!
      expect(listbox1).toBeTruthy()

      const opts = [...listbox1.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      expect(opts.length).toBe(3)
      for (const opt of opts) {
        expect(opt.id).toBeTruthy()
        expect(opt.getAttribute('tabindex')).toBe('-1')
      }

      // Opens highlighted on current selected ('pro', index 1)
      expect(trig1.getAttribute('aria-activedescendant')).toBe(opts[1]!.id)

      // Home -> index 0 ('free')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
      expect(trig1.getAttribute('aria-activedescendant')).toBe(opts[0]!.id)

      // End -> index 2 ('enterprise')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      expect(trig1.getAttribute('aria-activedescendant')).toBe(opts[2]!.id)

      // Tab closes without preventing default and removes aria-controls
      const tabEvt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      document.dispatchEvent(tabEvt)
      expect(tabEvt.defaultPrevented).toBe(false)
      expect(s1.host.querySelector('[role="listbox"]')).toBeNull()
      expect(trig1.getAttribute('aria-controls')).toBeNull()
      expect(trig1.getAttribute('aria-activedescendant')).toBeNull()

      // Open, End, Enter selects 'enterprise'
      trig1.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      expect(changes).toEqual(['enterprise'])
      expect(trig1.getAttribute('aria-controls')).toBeNull()
    }
    finally {
      s1.dispose()
      s2.dispose()
    }
  })

  it('CommandPalette: binds aria-expanded to open state, initializes activeIdx on first enabled item, preserves Home/End caret editing, handles Tab without closing modal, and polite live status region', () => {
    const CommandComp = uiMods.CommandPalette!
    const openSig = signal(false)
    const ran: string[] = []
    const c = mountInBody(() => CommandComp({
      open: openSig,
      items: [
        { id: 'locked', label: 'Alpha locked', disabled: true },
        { id: 'alpha', label: 'Alpha command' },
        { id: 'beta', label: 'Beta command' },
        { id: 'gamma', label: 'Gamma command' },
      ],
      onSelect: (id: string) => ran.push(id),
    }))

    try {
      const input = c.host.querySelector<HTMLInputElement>('[data-part="input"]')!
      const list = c.host.querySelector<HTMLElement>('[role="listbox"]')!
      const liveRegion = c.host.querySelector<HTMLElement>('[role="status"][aria-live="polite"]')!

      // Closed state: aria-expanded must be "false" (NOT hardcoded "true"), no aria-activedescendant
      expect(input.getAttribute('aria-expanded')).toBe('false')
      expect(input.getAttribute('aria-controls')).toBe(list.id)
      expect(list.id).toBeTruthy()
      expect(Boolean(list.getAttribute('aria-label') || list.getAttribute('aria-labelledby'))).toBe(true)
      expect(input.getAttribute('aria-activedescendant')).toBeNull()
      expect(liveRegion).toBeTruthy()

      // Open palette -> activeIdx initializes via findFirstEnabledIndex (skips disabled index 0 -> lands on index 1 'alpha')
      openSig.value = true
      expect(input.getAttribute('aria-expanded')).toBe('true')

      const opts = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      expect(opts.length).toBe(4)
      for (const opt of opts) {
        expect(opt.id).toBeTruthy()
        expect(opt.getAttribute('tabindex')).toBe('-1')
      }
      expect(input.getAttribute('aria-activedescendant')).toBe(opts[1]!.id)
      expect(liveRegion.textContent?.trim()).toMatch(/4\s+results/i)

      // Home and End inside the search text input must NOT be intercepted (caret movement preserved!)
      const endEvt = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })
      input.dispatchEvent(endEvt)
      expect(endEvt.defaultPrevented).toBe(false)
      expect(input.getAttribute('aria-activedescendant')).toBe(opts[1]!.id)

      const homeEvt = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })
      input.dispatchEvent(homeEvt)
      expect(homeEvt.defaultPrevented).toBe(false)
      expect(input.getAttribute('aria-activedescendant')).toBe(opts[1]!.id)

      // ArrowDown moves to index 2 ('beta')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(input.getAttribute('aria-activedescendant')).toBe(opts[2]!.id)

      // Filter matching disabled item first ('alpha') -> activeIdx still picks first enabled ('alpha', index 1)
      input.value = 'alpha'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const alphaOpts = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      expect(alphaOpts.length).toBe(2)
      expect(input.getAttribute('aria-activedescendant')).toBe(alphaOpts[1]!.id)

      // Filter to 1 result -> live region announces "1 result"
      input.value = 'beta'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      expect(liveRegion.textContent?.trim()).toMatch(/1\s+result\b/i)

      // Filter to 0 results -> live region announces "No results" and aria-activedescendant is cleared
      input.value = 'zzzzzz'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      expect(liveRegion.textContent?.trim()).toMatch(/no\s+results/i)
      expect(input.getAttribute('aria-activedescendant')).toBeNull()

      // Tab inside modal <dialog> does NOT prevent default and does NOT prematurely close the modal
      const tabEvt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      input.dispatchEvent(tabEvt)
      expect(tabEvt.defaultPrevented).toBe(false)
      expect(openSig.value).toBe(true)

      // Escape closes the modal cleanly
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(openSig.value).toBe(false)
      expect(input.getAttribute('aria-expanded')).toBe('false')

      // Re-open and press Enter immediately -> runs first enabled item ('alpha'), NOT disabled index 0
      openSig.value = true
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      expect(ran).toEqual(['alpha'])
    }
    finally {
      c.dispose()
    }
  })
})

describe('Box 21 — Dialog, Drawer, Field, DataTable search & CommandPalette labelling', () => {
  it('Dialog & Drawer: wire unique IDs for aria-labelledby (or fallback aria-label) and aria-describedby', () => {
    const parser = new DOMParser()
    const doc = parser.parseFromString(ssrHtml, 'text/html')

    const dialogs = [...doc.querySelectorAll('dialog[data-ui="dialog"]')]
    expect(dialogs.length).toBe(2)

    const d1 = dialogs[0]!
    const d1Title = d1.querySelector('[data-part="title"]')!
    const d1Desc = d1.querySelector('[data-part="description"]')!
    expect(d1Title.id).toBeTruthy()
    expect(d1Desc.id).toBeTruthy()
    expect(d1.getAttribute('aria-labelledby')).toBe(d1Title.id)
    expect(d1.getAttribute('aria-describedby')).toBe(d1Desc.id)

    const d2 = dialogs[1]!
    expect(d2.getAttribute('aria-labelledby')).toBeNull()
    expect(d2.getAttribute('aria-label')).toBe('Fallback dialog')
    expect(d2.getAttribute('aria-describedby')).toBeNull()

    const drawer = doc.querySelector('dialog[data-ui="drawer"]')!
    const drTitle = drawer.querySelector('[data-part="title"]')!
    const drDesc = drawer.querySelector('[data-part="description"]')!
    expect(drTitle.id).toBeTruthy()
    expect(drDesc.id).toBeTruthy()
    expect(drTitle.id).not.toBe(d1Title.id)
    expect(drawer.getAttribute('aria-labelledby')).toBe(drTitle.id)
    expect(drawer.getAttribute('aria-describedby')).toBe(drDesc.id)
  })

  it('Field: wires aria-describedby, aria-invalid, required, aria-required & missing id in SSR while staying 0 KB client JS', async () => {
    const parser = new DOMParser()
    const doc = parser.parseFromString(ssrHtml, 'text/html')

    const emailInput = doc.querySelector('input[name="email"]')!
    expect(emailInput.getAttribute('aria-describedby')).toBe('email-hint')
    expect(emailInput.hasAttribute('required')).toBe(true)
    expect(emailInput.getAttribute('aria-required')).toBe('true')
    expect(emailInput.getAttribute('aria-invalid')).toBeNull()

    const userInput = doc.querySelector('input[name="username"]')!
    expect(userInput.id).toBe('username')
    expect(userInput.getAttribute('aria-describedby')).toContain('extra-note')
    expect(userInput.getAttribute('aria-describedby')).toContain('username-error')
    expect(userInput.getAttribute('aria-invalid')).toBe('true')
    expect(userInput.hasAttribute('required')).toBe(true)
    expect(userInput.getAttribute('aria-required')).toBe('true')

    // Confirm Field stays 0 KB client JS!
    const staticDir = makeTemp('kay-audit-field-static-')
    mkdirSync(join(staticDir, 'src/routes'), { recursive: true })
    writeFileSync(join(staticDir, 'src/routes/index.tsx'), `
      import { Field } from ${JSON.stringify(UI_ENTRY)}
      export default async function Page() {
        return (
          <Field id="f1" label="Name" hint="Full name" required>
            <input name="name" type="text" />
          </Field>
        )
      }
    `)
    const manifest = await build({ root: staticDir, plugins: [ui({ grammar: false })] })
    expect(manifest.runtimeScript).toBeUndefined()
  })

  it('DataTable search & CommandPalette input have accessible aria-label (default & configurable)', () => {
    const parser = new DOMParser()
    const doc = parser.parseFromString(ssrHtml, 'text/html')

    const dtSearch = doc.querySelector('[data-ui="datatable"] [data-part="search"]')!
    expect(dtSearch.getAttribute('aria-label')?.trim().length).toBeGreaterThan(0)

    const cmdInput = doc.querySelector('dialog[data-ui="command"] [data-part="input"]')!
    expect(cmdInput.getAttribute('aria-label')?.trim().length).toBeGreaterThan(0)

    const cmdDialog = doc.querySelector('dialog[data-ui="command"]')!
    expect(Boolean(cmdDialog.getAttribute('aria-label') || cmdDialog.getAttribute('aria-labelledby'))).toBe(true)

    // Configurable labels via props (for i18n / RGAA in non-English apps)
    const TableComp = uiMods.DataTable!
    const CommandComp = uiMods.CommandPalette!
    const DialogComp = uiMods.ControlledDialog!
    const DrawerComp = uiMods.ControlledDrawer!
    const ToasterComp = uiMods.Toaster!
    const t = mountInBody(() => TableComp({
      rows: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }],
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'id', label: 'ID', sortable: false },
      ],
      pageSize: 1,
      selectable: true,
      caption: 'Liste des utilisateurs',
      searchLabel: 'Filtrer les utilisateurs',
      selectColumnLabel: 'Sélectionner',
      selectRowLabel: 'Sélectionner la ligne',
      rowsLabel: 'lignes',
      prevLabel: 'Précédent',
      nextLabel: 'Suivant',
    }))
    const tLabelled = mountInBody(() => TableComp({
      rows: [{ id: '1', name: 'A' }],
      columns: [{ key: 'name', label: 'Name' }],
      ariaLabel: 'Users table',
    }))
    const c = mountInBody(() => CommandComp({
      items: [],
      inputLabel: 'Rechercher une action',
      emptyLabel: 'Aucune commande.',
      noResultsLabel: 'Aucun résultat',
    }))
    const dlg = mountInBody(() => DialogComp({
      title: 'Paramètres',
      closeLabel: 'Fermer',
      open: signal(false),
    }))
    const drw = mountInBody(() => DrawerComp({
      title: 'Navigation',
      closeLabel: 'Fermer le panneau',
      open: signal(false),
    }))
    toastApi.show('Enregistré', undefined, 0)
    const tst = mountInBody(() => ToasterComp({ dismissLabel: 'Ignorer' }))
    try {
      expect(t.host.querySelector('[data-part="search"]')?.getAttribute('aria-label')).toBe('Filtrer les utilisateurs')
      // RGAA 5.4 / 5.6 / 5.7: caption, aria-label fallback, scope="col", non-empty selectable <th>, aria-hidden sort arrows
      expect(t.host.querySelector('table > caption')?.textContent).toBe('Liste des utilisateurs')
      expect(t.host.querySelector('table')?.getAttribute('aria-label')).toBeNull()
      expect(tLabelled.host.querySelector('table > caption')).toBeNull()
      expect(tLabelled.host.querySelector('table')?.getAttribute('aria-label')).toBe('Users table')
      const ths = [...t.host.querySelectorAll('thead th')]
      expect(ths.length).toBe(3)
      for (const th of ths)
        expect(th.getAttribute('scope')).toBe('col')
      const selectTh = t.host.querySelector('th[data-part="select-col"]')!
      expect(selectTh.textContent?.trim()).toBe('Sélectionner')
      expect(selectTh.querySelector('.kui-sr-only')?.textContent).toBe('Sélectionner')
      // Non-sortable column omits aria-sort
      expect(ths[2]!.getAttribute('aria-sort')).toBeNull()
      // Sort arrow indicator is aria-hidden="true"
      const sortBtn = t.host.querySelector<HTMLButtonElement>('button[data-part="sort"]')!
      sortBtn.click()
      const arrowSpan = sortBtn.querySelector<HTMLElement>('[aria-hidden="true"]')!
      expect(arrowSpan).toBeTruthy()
      expect(arrowSpan.textContent).toContain('↑')

      expect(t.host.querySelector('td[data-part="select-col"] input')?.getAttribute('aria-label')).toBe('Sélectionner la ligne 1')
      expect(t.host.textContent).toContain('Précédent')
      expect(t.host.textContent).toContain('Suivant')
      expect(c.host.querySelector('[data-part="input"]')?.getAttribute('aria-label')).toBe('Rechercher une action')
      expect(c.host.querySelector('[data-part="empty"]')?.textContent).toBe('Aucune commande.')
      expect(dlg.host.querySelector('[data-part="close"]')?.getAttribute('aria-label')).toBe('Fermer')
      expect(drw.host.querySelector('[data-part="close"]')?.getAttribute('aria-label')).toBe('Fermer le panneau')
      expect(tst.host.querySelector('[data-part="close"]')?.getAttribute('aria-label')).toBe('Ignorer')
    }
    finally {
      toastApi.clear()
      t.dispose()
      tLabelled.dispose()
      c.dispose()
      dlg.dispose()
      drw.dispose()
      tst.dispose()
    }
  })

  it('#3636 Field error ARIA wiring & Field+Select label association in interactive islands + Switch focus indicator + Toast timer cleanup', () => {
    // 1. Field dynamic error ARIA wiring in an interactive island without remounting the input
    const FieldIsland = uiMods.FieldIsland!
    const err = signal<string | undefined>(undefined)
    const f = mountInBody(() => FieldIsland({ err }))
    try {
      const input = f.host.querySelector<HTMLInputElement>('input[name="email"]')!
      expect(input.id).toBe('isl-email')
      expect(input.getAttribute('aria-invalid')).toBeNull()
      expect(input.getAttribute('aria-describedby')).toContain('extra-island')
      expect(input.getAttribute('aria-describedby')).toContain('isl-email-hint')

      input.value = 'not-an-email'
      err.value = 'Invalid email'
      // Same DOM node preserved (user input not wiped), ARIA updated reactively
      expect(f.host.querySelector('input[name="email"]')).toBe(input)
      expect(input.value).toBe('not-an-email')
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(input.getAttribute('aria-describedby')).toContain('extra-island')
      expect(input.getAttribute('aria-describedby')).toContain('isl-email-error')
      expect(input.getAttribute('aria-describedby')).not.toContain('isl-email-hint')

      err.value = undefined
      expect(input.getAttribute('aria-invalid')).toBeNull()
      expect(input.getAttribute('aria-describedby')).toContain('extra-island')
      expect(input.getAttribute('aria-describedby')).toContain('isl-email-hint')
      expect(input.getAttribute('aria-describedby')).not.toContain('isl-email-error')
    }
    finally {
      f.dispose()
    }

    // 2. <Field><Select /></Field> wires trigger id to match <label for> and updates error ARIA
    const FieldSelectIsland = uiMods.FieldSelectIsland!
    const selErr = signal<string | undefined>('Choose a plan')
    const fs = mountInBody(() => FieldSelectIsland({ err: selErr }))
    try {
      const label = fs.host.querySelector<HTMLLabelElement>('label[data-part="label"]')!
      const trigger = fs.host.querySelector<HTMLButtonElement>('[data-ui="select"] [data-part="trigger"]')!
      expect(label.getAttribute('for')).toBe('isl-plan')
      expect(trigger.id).toBe('isl-plan')
      expect(trigger.getAttribute('aria-invalid')).toBe('true')
      expect(trigger.getAttribute('aria-describedby')).toBe('isl-plan-error')

      trigger.click()
      const listbox = fs.host.querySelector<HTMLElement>('[role="listbox"]')!
      expect(listbox.getAttribute('aria-labelledby')).toBe('isl-plan')

      selErr.value = undefined
      expect(trigger.getAttribute('aria-invalid')).toBeNull()
      expect(trigger.getAttribute('aria-describedby')).toBe('isl-plan-hint')
    }
    finally {
      fs.dispose()
    }

    // 3. Switch keyboard focus-visible indicator exists in bare.css
    const bareCss = readFileSync(join(STYLES_DIR, 'bare.css'), 'utf8')
    expect(bareCss).toContain('[data-ui="switch"]:has(input:focus-visible) [data-part="track"]')

    // 4. Toast clears setTimeout handles on manual dismiss() and clear()
    const cleared: unknown[] = []
    const origClearTimeout = globalThis.clearTimeout
    globalThis.clearTimeout = ((id: unknown) => {
      cleared.push(id)
      return origClearTimeout(id as ReturnType<typeof setTimeout>)
    }) as typeof clearTimeout
    try {
      const id1 = toastApi.show('One', undefined, 60_000)
      toastApi.dismiss(id1)
      expect(cleared.length).toBe(1)

      toastApi.show('Two', undefined, 60_000)
      toastApi.show('Three', undefined, 60_000)
      toastApi.clear()
      expect(cleared.length).toBe(3)
      expect(toastApi.items.value.length).toBe(0)
    }
    finally {
      globalThis.clearTimeout = origClearTimeout
      toastApi.clear()
    }
  })
})

describe('Box 24 — WCAG Contrast >= 4.5:1 across all grammars, Orbit focus indicator, prefers-reduced-motion', () => {
  const grammars = ['editorial', 'workshop', 'soft', 'console', 'orbit'] as const

  for (const name of grammars) {
    it(`${name}.css: achieves >= 4.5:1 text contrast on paper, surface, accent & status fills, and >= 3:1 interactive borders (light & dark)`, () => {
      const css = readFileSync(join(GRAMMARS_DIR, `${name}.css`), 'utf8')
      const tokens = parseRootTokens(css)

      // Must NOT hardcode `color: #fff` directly on dark-mode bright accent/status fills
      expect(css).not.toMatch(/data-tone="(?:accent|danger|success|warning)"[^}]*color:\s*#fff\b/i)
      expect(css).not.toMatch(/data-state="active"[^}]*background:\s*var\(--ui-accent\)[^}]*color:\s*#fff\b/i)
      expect(css).not.toMatch(/data-selected="true"[^}]*background:\s*var\(--ui-accent\)[^}]*color:\s*#fff\b/i)
      expect(css).not.toMatch(/data-highlighted="true"[^}]*background:\s*var\(--ui-accent\)[^}]*color:\s*#fff\b/i)

      for (const mode of ['light', 'dark'] as const) {
        const t = tokens[mode]
        const paper = t['--ui-paper']!
        const surface = t['--ui-surface']!
        const ink = t['--ui-ink']!
        const muted = t['--ui-muted']!
        const accent = t['--ui-accent']!
        const accentFill = t['--ui-accent-fill'] ?? accent
        const success = t['--ui-success']!
        const warning = t['--ui-warning']!
        const danger = t['--ui-danger']!
        const onFill = t['--ui-on-accent'] ?? t['--ui-on-fill']
        const borderToken = t['--ui-line-strong'] ?? t['--ui-line']!

        expect(onFill, `${name}/${mode} must define --ui-on-accent`).toBeTruthy()
        expect(borderToken, `${name}/${mode} must define interactive border token`).toBeTruthy()

        // Text on paper & surface >= 4.5:1
        expect(contrastRatio(ink, paper)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(muted, paper)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(muted, surface)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(accent, paper)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(accent, surface)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(success, paper)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(success, surface)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(warning, paper)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(warning, surface)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(danger, paper)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(danger, surface)).toBeGreaterThanOrEqual(4.5)

        // Text on filled accent/status surfaces >= 4.5:1
        expect(contrastRatio(onFill!, accentFill)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(onFill!, danger)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(onFill!, success)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(onFill!, warning)).toBeGreaterThanOrEqual(4.5)

        // Interactive control border/underline >= 3.0:1
        expect(contrastRatio(borderToken, paper)).toBeGreaterThanOrEqual(3.0)
        expect(contrastRatio(borderToken, surface)).toBeGreaterThanOrEqual(3.0)

        // Grammar-specific surface checks
        if (name === 'soft') {
          const surface2 = t['--ui-surface-2']!
          expect(contrastRatio(muted, surface2)).toBeGreaterThanOrEqual(4.5)
          expect(contrastRatio(accent, mixSrgb(accent, 16, surface))).toBeGreaterThanOrEqual(4.5)
          expect(contrastRatio(success, mixSrgb(success, 16, surface))).toBeGreaterThanOrEqual(4.5)
          expect(contrastRatio(warning, mixSrgb(warning, 18, surface))).toBeGreaterThanOrEqual(4.5)
          expect(contrastRatio(danger, mixSrgb(danger, 16, surface))).toBeGreaterThanOrEqual(4.5)
        }
        if (name === 'orbit') {
          const surfaceStrong = t['--ui-surface-strong']!
          expect(contrastRatio(accent, surfaceStrong)).toBeGreaterThanOrEqual(4.5)
          expect(contrastRatio(danger, mixSrgb(danger, 12, surface))).toBeGreaterThanOrEqual(4.5)
        }
        if (name === 'console') {
          expect(contrastRatio(danger, mixSrgb(danger, 12, paper))).toBeGreaterThanOrEqual(4.5)
        }
      }
    })
  }

  it('editorial.css: field underline uses high-contrast --ui-line-strong (>= 3:1)', () => {
    const css = readFileSync(join(GRAMMARS_DIR, 'editorial.css'), 'utf8')
    const fieldBlock = css.match(/\[data-ui="field"\]\s*\{[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(fieldBlock).toContain('var(--ui-line-strong)')
  })

  it('orbit.css: command palette input preserves a clear visible :focus-visible indicator', () => {
    const css = readFileSync(join(GRAMMARS_DIR, 'orbit.css'), 'utf8')
    const cmdBlock = css.slice(css.indexOf('dialog[data-ui="command"] {'))
    const inputBlock = cmdBlock.match(/&\s*\[data-part="input"\]\s*\{[\s\S]*?\n\s*\}/)?.[0] ?? ''
    expect(inputBlock).not.toMatch(/&:focus\s*\{\s*outline:\s*none;\s*\}/)
    expect(inputBlock).toContain(':focus-visible')
    expect(inputBlock).toMatch(/outline:|border-bottom-color:/)
  })

  it('bare.css: includes @media (prefers-reduced-motion: reduce) disabling/minimizing transitions and animations', () => {
    const css = readFileSync(join(STYLES_DIR, 'bare.css'), 'utf8')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toMatch(/animation-duration\s*:/)
    expect(css).toMatch(/transition-duration\s*:/)
  })
})

describe('Box 40 — ControlledDialog, ControlledDrawer, CommandPalette: open={signal(true)} on mount & padding click does not close', () => {
  // The browser closes a ControlledDialog or ControlledDrawer on a backdrop click (`closedby="any"`), which happy-dom lacks: ui.test.ts checks it in Chromium.
  it('ControlledDialog opens immediately when mounted with open={signal(true)} and ignores clicks on inner padding panel', () => {
    const DialogComp = uiMods.ControlledDialog!
    const openSig = signal(true)
    const mounted = mountInBody(() => DialogComp({
      title: 'Confirm',
      open: openSig,
    }))
    try {
      const dialog = mounted.host.querySelector<HTMLDialogElement>('dialog[data-ui="dialog"]')!
      const panel = dialog.querySelector<HTMLElement>('[data-part="panel"]')!
      expect(dialog.open).toBe(true)
      expect(panel).toBeTruthy()

      // Click on panel (dialog padding area) must NOT close the dialog
      panel.click()
      expect(openSig.value).toBe(true)
      expect(dialog.open).toBe(true)
    }
    finally {
      mounted.dispose()
    }
  })

  it('ControlledDrawer opens immediately when mounted with open={signal(true)} and ignores clicks on inner padding panel', () => {
    const DrawerComp = uiMods.ControlledDrawer!
    const openSig = signal(true)
    const mounted = mountInBody(() => DrawerComp({
      title: 'Side panel',
      open: openSig,
    }))
    try {
      const dialog = mounted.host.querySelector<HTMLDialogElement>('dialog[data-ui="drawer"]')!
      const panel = dialog.querySelector<HTMLElement>('[data-part="panel"]')!
      expect(dialog.open).toBe(true)
      expect(panel).toBeTruthy()

      panel.click()
      expect(openSig.value).toBe(true)
      expect(dialog.open).toBe(true)
    }
    finally {
      mounted.dispose()
    }
  })

  it('CommandPalette opens immediately when mounted with open={signal(true)}, ignores clicks on inner panel, and closes on backdrop click', () => {
    const CommandComp = uiMods.CommandPalette!
    const openSig = signal(true)
    const mounted = mountInBody(() => CommandComp({
      open: openSig,
      items: [{ id: 'a', label: 'Alpha' }],
    }))
    try {
      const dialog = mounted.host.querySelector<HTMLDialogElement>('dialog[data-ui="command"]')!
      const panel = dialog.querySelector<HTMLElement>('[data-part="panel"]')!
      expect(dialog.open).toBe(true)
      expect(panel).toBeTruthy()

      panel.click()
      expect(openSig.value).toBe(true)
      expect(dialog.open).toBe(true)

      dialog.click()
      expect(openSig.value).toBe(false)
      expect(dialog.open).toBe(false)
    }
    finally {
      mounted.dispose()
    }
  })

  it('bare.css & all grammars zero padding on <dialog> and put padding on [data-part="panel"]', () => {
    const bare = readFileSync(join(STYLES_DIR, 'bare.css'), 'utf8')
    expect(bare).toMatch(/dialog\[data-ui="dialog"\][^\{]*\{[^}]*padding:\s*0;/)

    for (const name of ['editorial', 'workshop', 'soft', 'console', 'orbit']) {
      const css = readFileSync(join(GRAMMARS_DIR, `${name}.css`), 'utf8')
      const dialogBlock = css.match(/dialog\[data-ui="dialog"\]\s*\{[\s\S]*?\n\s*\}/)?.[0] ?? ''
      expect(dialogBlock, `${name}.css dialog should not have direct non-zero padding`).not.toMatch(/^\s*padding:\s*[1-9]/m)
      expect(dialogBlock, `${name}.css dialog should style > [data-part="panel"]`).toContain('> [data-part="panel"]')
    }
  })
})

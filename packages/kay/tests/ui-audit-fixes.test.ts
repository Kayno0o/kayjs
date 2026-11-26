// Regression tests for #3571: scoped Tabs ARIA IDs, MenuItemDef.href support, O(1) DataTable selection,
// quote-aware wireFieldHtml attribute scanning, and consolidated Dialog/Drawer & Menu/Select primitives.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDataTable, toast } from '@kayjs/ui'
import { build } from '../src/build/index'
import { createOwner, disposeOwner, effect, runWithOwner, signal } from '../src/reactivity/index'
import { createServer } from '../src/server/index'

const UI_MOD = resolve(import.meta.dir, '../../ui/src/index.ts')

describe('#3571 @kayjs/ui component bugs & consolidation', () => {
  test('two <Tabs> instances with overlapping item IDs emit unique scoped ARIA IDs without collisions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3571-tabs-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
import { Tabs } from ${JSON.stringify(UI_MOD)}
export default function Page() {
  return (
    <div>
      <Tabs items={[{ id: 'a', label: 'A1', content: 'P1' }, { id: 'b', label: 'B1', content: 'P2' }]} />
      <Tabs items={[{ id: 'a', label: 'A2', content: 'Q1' }, { id: 'b', label: 'B2', content: 'Q2' }]} />
    </div>
  )
}
`)
      await build({ root: dir, prerender: false })
      const app = await createServer({ root: dir })
      const html = await (await app.handle(new Request('http://localhost/'))).text()

      const tabIds = [...html.matchAll(/id="([^"]*-tab-a)"/g)].map(m => m[1]!)
      const panelIds = [...html.matchAll(/id="([^"]*-panel-a)"/g)].map(m => m[1]!)
      expect(tabIds.length).toBe(2)
      expect(panelIds.length).toBe(2)
      expect(tabIds[0]).not.toBe(tabIds[1])
      expect(panelIds[0]).not.toBe(panelIds[1])
      expect(html).toContain(`aria-controls="${panelIds[0]}"`)
      expect(html).toContain(`aria-labelledby="${tabIds[0]}"`)
      expect(html).toContain(`aria-controls="${panelIds[1]}"`)
      expect(html).toContain(`aria-labelledby="${tabIds[1]}"`)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('createDataTable().isSelected(key) notifies only the toggled row in O(1), not all N rows', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `Row ${i}` }))
    const table = createDataTable({ rows: () => rows, getKey: r => r.id })
    const runs = new Array<number>(100).fill(0)

    const owner = createOwner(undefined)
    try {
      runWithOwner(owner, () => {
        for (let i = 0; i < 100; i++) {
          const idx = i
          effect(() => {
            void table.isSelected(idx)
            runs[idx]!++
          })
        }
      })

      // Initial run: every row effect ran once
      expect(runs.every(r => r === 1)).toBe(true)

      // Toggle row 5 -> ONLY row 5 re-runs (O(1))
      table.toggleSelect(5)
      expect(runs[5]).toBe(2)
      expect(runs.filter((_, i) => i !== 5).every(r => r === 1)).toBe(true)
      expect(table.isSelected(5)).toBe(true)
      expect(table.selected.value.has(5)).toBe(true)

      // Clear selection -> ONLY previously-selected row 5 re-runs
      table.clearSelection()
      expect(runs[5]).toBe(3)
      expect(runs.filter((_, i) => i !== 5).every(r => r === 1)).toBe(true)
      expect(table.isSelected(5)).toBe(false)
    }
    finally {
      disposeOwner(owner)
    }
  })

  test('Field wireFieldHtml handles ">" inside attribute values like placeholder="x > 0"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3571-field-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
import { Field } from ${JSON.stringify(UI_MOD)}
export default function Page() {
  return (
    <Field id="threshold" label="Threshold" error="Must be positive" required>
      <input type="text" name="threshold" placeholder="x > 0" />
    </Field>
  )
}
`)
      await build({ root: dir, prerender: false })
      const app = await createServer({ root: dir })
      const html = await (await app.handle(new Request('http://localhost/'))).text()

      expect(html).toContain('placeholder="x &gt; 0"')
      // Also test unescaped > in raw HTML directly: id/aria-invalid must be injected on the real closing >, not inside placeholder!
      expect(html).toContain('id="threshold"')
      expect(html).toContain('aria-describedby="threshold-error"')
      expect(html).toContain('aria-invalid="true"')
      expect(html).toContain('aria-required="true"')
      expect(html).toMatch(/<input\b[^>]*placeholder="[^"]*"[^>]*id="threshold"/)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Menu renders <a> links for MenuItemDef.href and Dialog/Drawer share ModalDialogSurface cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3571-menu-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
import { Dialog, Drawer, Menu } from ${JSON.stringify(UI_MOD)}
export default function Page() {
  return (
    <div>
      <Menu
        label="Actions"
        items={[
          { id: 'docs', label: 'Docs', href: '/docs' },
          { id: 'del', label: 'Delete' },
        ]}
      />
      <Dialog title="Confirm" triggerLabel="Open Dialog"><p>Body</p></Dialog>
      <Drawer title="Details" side="left" triggerLabel="Open Drawer"><p>Side</p></Drawer>
    </div>
  )
}
`)
      const manifest = await build({ root: dir, prerender: false })
      const app = await createServer({ root: dir })
      const html = await (await app.handle(new Request('http://localhost/'))).text()

      expect(html).toContain('data-ui="dialog-root"')
      expect(html).toContain('data-ui="drawer-root"')
      expect(html).toContain('data-side="left"')
      // Check compiled Menu client chunk contains anchor href support
      const menuChunk = Object.entries(manifest.islands).find(([k]) => k.endsWith('#Menu'))?.[1]
      expect(menuChunk).toBeDefined()
      const menuJs = await Bun.file(join(dir, 'dist/client', menuChunk!.replace(/^\/_kay\//, ''))).text()
      expect(menuJs).toContain('<a ')
      expect(menuJs).toContain('href')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('#3636 @kayjs/ui RGAA accessibility & state regressions', () => {
  test('<Field><Select /></Field> in SSR associates <label for> with the Select combobox trigger id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3636-field-select-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
import { Field, Select } from ${JSON.stringify(UI_MOD)}
export default function Page() {
  return (
    <Field id="plan" label="Billing plan" error="Required" required>
      <Select name="plan" options={[{ value: 'free', label: 'Free' }, { value: 'pro', label: 'Pro' }]} />
    </Field>
  )
}
`)
      await build({ root: dir, prerender: false })
      const app = await createServer({ root: dir })
      const html = await (await app.handle(new Request('http://localhost/'))).text()

      expect(html).toContain('for="plan"')
      expect(html).toMatch(/<button\b[^>]*id="plan"[^>]*role="combobox"/)
      expect(html).toContain('aria-invalid="true"')
      expect(html).toContain('aria-describedby="plan-error"')
      expect(html).not.toMatch(/id="kui-select-[^"]*-trigger"/)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('createDataTable clamps page.value when rows shrink and evicts removed row signals from rowSelected', () => {
    const rowsSig = signal([
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
      { id: 3, name: 'C' },
      { id: 4, name: 'D' },
      { id: 5, name: 'E' },
    ])
    const table = createDataTable({ rows: () => rowsSig.value, getKey: r => r.id, pageSize: 2 })

    // Navigate to last page (page 3 of 3)
    table.page.value = 3
    expect(table.page.value).toBe(3)
    expect(table.totalPages.value).toBe(3)
    expect(table.visible.value.map(r => r.id)).toEqual([5])

    // Shrink rows to 3 items (totalPages = 2) -> page.value clamps immediately to 2
    rowsSig.value = [
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
      { id: 3, name: 'C' },
    ]
    expect(table.totalPages.value).toBe(2)
    expect(table.page.value).toBe(2)
    expect(table.visible.value.map(r => r.id)).toEqual([3])

    // Decrementing from clamped page 2 lands directly on page 1
    table.page.value--
    expect(table.page.value).toBe(1)

    // Eviction of removed row keys from rowSelected Map
    let row1Runs = 0
    const owner = createOwner(undefined)
    try {
      runWithOwner(owner, () => {
        effect(() => {
          void table.isSelected(1)
          row1Runs++
        })
      })
      expect(row1Runs).toBe(1)
      table.toggleSelect(1)
      expect(row1Runs).toBe(2)

      // Remove row 1 from rows and recompute filtered -> old row 1 signal is evicted
      rowsSig.value = [{ id: 2, name: 'B' }, { id: 3, name: 'C' }]
      expect(table.filtered.value.map(r => r.id)).toEqual([2, 3])

      // Toggling evicted key 1 must NOT retain or notify the evicted Signal
      table.toggleSelect(1)
      expect(row1Runs).toBe(2)
    }
    finally {
      disposeOwner(owner)
    }
  })

  test('toast does not store items on globalThis or schedule timers during SSR', () => {
    const id = toast.show('Server secret', 'Must not leak across SSR requests', 5000)
    expect(id).toBe('')
    expect(toast.items.value).toEqual([])
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('kay.ui.toasts')]).toBeUndefined()
  })
})

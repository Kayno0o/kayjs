import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createDataTable } from '../../ui/src/behaviors'
import { ejectGrammar, grammarCssPath, ui } from '../../ui/src/plugin'
import { build } from '../src/build/index'
import { testApp } from '../src/test/index'

const UI_ENTRY = join(import.meta.dir, '../../ui/src/index.ts')
const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('@kayjs/ui v2 — Platform-first primitives & Pure CSS Style Grammars', () => {
  it('ships 0 KB client JS when a page uses only static & native-platform primitives', async () => {
    const dir = makeTemp('kay-ui-static-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import {
        Accordion, AccordionItem, Badge, Button, Card, CardBody, CardFooter, CardHeader,
        Checkbox, Cluster, Field, Grid, Notice, Popover, RadioGroup, Stack, Switch,
      } from ${JSON.stringify(UI_ENTRY)}

      export default async function Home() {
        return (
          <Stack gap="1.5rem">
            <Cluster>
              <Button tone="accent">Save</Button>
              <Button variant="outline" href="/docs">Docs</Button>
              <Badge tone="success">Ready</Badge>
            </Cluster>
            <Notice tone="warning">Check your settings.</Notice>
            <Grid min="14rem">
              <Card>
                <CardHeader>Card One</CardHeader>
                <CardBody>Zero JS semantic markup.</CardBody>
                <CardFooter>Footer</CardFooter>
              </Card>
            </Grid>
            <Field id="email" label="Email" hint="Work email" required>
              <input id="email" name="email" type="email" />
            </Field>
            <Switch name="dark" label="Dark mode" checked />
            <Checkbox name="terms" label="Accept terms" />
            <RadioGroup name="tier" legend="Tier" defaultValue="free" options={[{ value: 'free', label: 'Free' }, { value: 'pro', label: 'Pro' }]} />
            <Accordion>
              <AccordionItem title="Question 1" group="faq" open>Answer 1</AccordionItem>
              <AccordionItem title="Question 2" group="faq">Answer 2</AccordionItem>
            </Accordion>
            <Popover id="info-pop" triggerLabel="Info">Native popover content</Popover>
          </Stack>
        )
      }
    `)

    const plugins = [ui({ grammar: 'editorial' })]
    const manifest = await build({ root: dir, plugins })
    // 0 KB JS runtime!
    expect(manifest.runtimeScript).toBeUndefined()
    expect(manifest.styles.length).toBe(1)

    const app = await testApp({ root: dir, plugins, prebuilt: true })
    const html = await (await app.get('/')).text()
    expect(html).not.toContain('<script')
    expect(html).toContain('data-ui="button"')
    expect(html).toContain('data-ui="card"')
    expect(html).toContain('data-ui="switch"')
    expect(html).toContain('data-ui="checkbox"')
    expect(html).toContain('data-ui="radio-group"')
    expect(html).toContain('data-ui="accordion"')
    expect(html).toContain('popovertarget="info-pop"')
    expect(html).toContain('data-layout="stack"')
  })

  it('ejects a complete standalone CSS Grammar file via ejectGrammar()', () => {
    const dir = makeTemp('kay-ui-eject-')
    const out = ejectGrammar(dir, 'workshop', 'src/styles/my-ui.css')
    expect(existsSync(out)).toBe(true)
    const css = readFileSync(out, 'utf8')
    expect(css).toContain('@layer kui')
    expect(css).toContain('[data-layout="stack"]')
    expect(css).toContain('Grammar: Workshop')
    expect(css).not.toContain("@import '../bare.css'")

    const orbitOut = ejectGrammar(dir, 'orbit', 'src/styles/orbit.css')
    const orbitCss = readFileSync(orbitOut, 'utf8')
    expect(orbitCss).toContain('Grammar: Orbit')
    expect(orbitCss).toContain('body::before')
    expect(orbitCss).toContain('radial-gradient')
    expect(orbitCss).not.toContain("@import '../bare.css'")
  })

  it('provides headless createDataTable() sorting, filtering, selection & pagination', () => {
    const rows = [
      { id: 1, name: 'Charlie', score: 20 },
      { id: 2, name: 'Alice', score: 50 },
      { id: 3, name: 'Bob', score: 30 },
    ]
    const table = createDataTable({ rows: () => rows, getKey: r => r.id, pageSize: 2 })
    expect(table.visible.value.length).toBe(2)
    expect(table.totalPages.value).toBe(2)

    table.toggleSort('name')
    expect(table.filtered.value.map(r => r.name)).toEqual(['Alice', 'Bob', 'Charlie'])
    table.toggleSort('name')
    expect(table.filtered.value.map(r => r.name)).toEqual(['Charlie', 'Bob', 'Alice'])

    table.query.value = 'ali'
    expect(table.filtered.value.map(r => r.name)).toEqual(['Alice'])

    table.toggleSelect(2)
    expect(table.isSelected(2)).toBe(true)
    expect(table.isSelected(1)).toBe(false)
    table.clearSelection()
    expect(table.isSelected(2)).toBe(false)
  })

  it('hydrates Dialog, Tabs, Menu, Select, Toaster & switches CSS Grammars structurally in Chromium', async () => {
    const dir = makeTemp('kay-ui-e2e-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/components'), { recursive: true })
    mkdirSync(join(dir, 'public/grammars'), { recursive: true })

    // Serve 3 grammars as switchable stylesheets in public/ to verify structural style swaps!
    for (const g of ['editorial', 'workshop', 'console'] as const)
      ejectGrammar(dir, g, `public/grammars/${g}.css`)

    writeFileSync(join(dir, 'src/components/ToastDemo.tsx'), `
      import { toast } from ${JSON.stringify(UI_ENTRY)}
      export function ToastDemo() {
        return (
          <button id="push-toast" data-ui="button" data-tone="accent" type="button" onClick={() => toast.success('Saved!', 'Your changes are live.', 0)}>
            Notify
          </button>
        )
      }
    `)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Head } from 'kay'
      import { Card, CardBody, CardHeader, CommandPalette, DataTable, Dialog, Drawer, Menu, Select, Tabs, Toaster } from ${JSON.stringify(UI_ENTRY)}
      import { ToastDemo } from '../components/ToastDemo'

      export default async function Demo() {
        return (
          <main>
            <Head>
              <link id="grammar-link" rel="stylesheet" href="/grammars/editorial.css" />
            </Head>
            <Card id="demo-card">
              <CardHeader>Profile</CardHeader>
              <CardBody>Hello</CardBody>
            </Card>
            <Dialog title="Confirm action" triggerLabel="Open dialog">
              <p>Are you sure?</p>
            </Dialog>
            <Drawer title="Side panel" triggerLabel="Open drawer" side="right">
              <p>Drawer body</p>
            </Drawer>
            <CommandPalette
              triggerLabel="Open command"
              items={[
                { id: 'alpha', label: 'Alpha action', shortcut: 'A' },
                { id: 'beta', label: 'Beta action', shortcut: 'B' },
              ]}
            />
            <DataTable
              pageSize={2}
              selectable
              rows={[
                { id: '1', name: 'Charlie', score: 20 },
                { id: '2', name: 'Alice', score: 50 },
                { id: '3', name: 'Bob', score: 30 },
              ]}
              columns={[
                { key: 'name', label: 'Name' },
                { key: 'score', label: 'Score' },
              ]}
            />
            <Tabs
              defaultValue="one"
              items={[
                { id: 'one', label: 'Overview', content: 'Panel One' },
                { id: 'two', label: 'Settings', content: 'Panel Two' },
              ]}
            />
            <Menu
              label="Actions"
              items={[
                { id: 'edit', label: 'Edit item' },
                { id: 'del', label: 'Delete item' },
              ]}
            />
            <Select
              name="plan"
              ariaLabel="Plan"
              defaultValue="free"
              options={[
                { value: 'free', label: 'Free' },
                { value: 'pro', label: 'Pro' },
              ]}
            />
            <ToastDemo />
            <Toaster />
          </main>
        )
      }
    `)

    const app = await testApp({ root: dir, plugins: [ui({ grammar: false })] })
    const server = app.app.serve(0)

    const chromePath = [
      process.env.BUN_CHROME_PATH,
      chromium.executablePath(),
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
    ].find((p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p))

    if (chromePath === undefined) {
      server.stop(true)
      return
    }

    const browser = await chromium.launch({ headless: true, executablePath: chromePath })
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', err => errors.push(err.message))
      await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'networkidle' })

      // 1. Dialog open + Escape close
      await page.click('[data-ui="dialog-root"] [data-part="trigger"]')
      expect(await page.locator('dialog[data-ui="dialog"]').evaluate(el => (el as HTMLDialogElement).open)).toBe(true)
      await page.keyboard.press('Escape')
      expect(await page.locator('dialog[data-ui="dialog"]').evaluate(el => (el as HTMLDialogElement).open)).toBe(false)

      // 2. Tabs click + ArrowRight keyboard navigation
      expect(await page.locator('#panel-one').isVisible()).toBe(true)
      expect(await page.locator('#panel-two').isVisible()).toBe(false)
      await page.focus('#tab-one')
      await page.keyboard.press('ArrowRight')
      expect(await page.locator('#panel-two').isVisible()).toBe(true)
      expect(await page.locator('#tab-two').getAttribute('data-state')).toBe('active')

      // 3. Menu open + floats absolutely with opaque surface background + click item closes menu
      await page.click('[data-ui="menu"] [data-part="trigger"]')
      expect(await page.locator('[data-ui="menu"] [role="menu"]').isVisible()).toBe(true)
      const menuStyle = await page.locator('[data-ui="menu"] [role="menu"]').evaluate((el) => {
        const s = getComputedStyle(el)
        return { bg: s.backgroundColor, position: s.position }
      })
      expect(menuStyle.bg).not.toBe('rgba(0, 0, 0, 0)')
      expect(menuStyle.position).toBe('absolute')
      await page.click('[data-ui="menu"] [role="menuitem"]:first-child')
      expect(await page.locator('[data-ui="menu"] [role="menu"]').count()).toBe(0)

      // 4. Select open + pick option updates trigger & hidden form input
      await page.click('[data-ui="select"] [data-part="trigger"]')
      await page.click('[data-ui="select"] [role="option"]:nth-child(2)')
      expect(await page.locator('[data-ui="select"] [data-part="value"]').textContent()).toBe('Pro')
      expect(await page.locator('input[name="plan"]').inputValue()).toBe('pro')

      // 5. Toast push + dismiss
      await page.click('#push-toast')
      expect(await page.locator('[data-ui="toast"]').count()).toBe(1)
      expect(await page.locator('[data-ui="toast"] [data-part="title"]').textContent()).toBe('Saved!')
      await page.click('[data-ui="toast"] [data-part="close"]')
      expect(await page.locator('[data-ui="toast"]').count()).toBe(0)

      // 5b. Drawer open + Escape close
      await page.click('[data-ui="drawer-root"] [data-part="trigger"]')
      expect(await page.locator('dialog[data-ui="drawer"]').evaluate(el => (el as HTMLDialogElement).open)).toBe(true)
      await page.keyboard.press('Escape')
      expect(await page.locator('dialog[data-ui="drawer"]').evaluate(el => (el as HTMLDialogElement).open)).toBe(false)

      // 5c. CommandPalette open + live filter + Enter closes
      await page.click('[data-ui="command-root"] [data-part="trigger"]')
      expect(await page.locator('dialog[data-ui="command"]').evaluate(el => (el as HTMLDialogElement).open)).toBe(true)
      await page.fill('dialog[data-ui="command"] [data-part="input"]', 'beta')
      expect(await page.locator('dialog[data-ui="command"] [data-part="item"]').count()).toBe(1)
      await page.keyboard.press('Enter')
      expect(await page.locator('dialog[data-ui="command"]').evaluate(el => (el as HTMLDialogElement).open)).toBe(false)

      // 5d. DataTable sort + filter + select
      expect(await page.locator('[data-ui="datatable"] tbody tr').count()).toBe(2) // pageSize=2
      await page.click('[data-ui="datatable"] thead th button[data-part="sort"]') // sort Name asc -> Alice first
      expect(await page.locator('[data-ui="datatable"] tbody tr:first-child td:nth-child(2)').textContent()).toBe('Alice')
      await page.fill('[data-ui="datatable"] [data-part="search"]', 'bob')
      expect(await page.locator('[data-ui="datatable"] tbody tr').count()).toBe(1)
      await page.click('[data-ui="datatable"] tbody tr:first-child input[type="checkbox"]')
      expect(await page.locator('[data-ui="datatable"] [data-part="meta"]').first().textContent()).toContain('1 selected')

      // 6. Verify switching Pure CSS Grammars changes actual STRUCTURE (borders, shadows, fonts) on the exact same DOM!
      const readCardStyle = () => page.locator('#demo-card').evaluate((el) => {
        const s = getComputedStyle(el)
        return { borderLeftWidth: s.borderLeftWidth, borderTopWidth: s.borderTopWidth, boxShadow: s.boxShadow, fontFamily: s.fontFamily }
      })

      const editorial = await readCardStyle()
      expect(editorial.borderLeftWidth).toBe('0px')
      expect(editorial.borderTopWidth).toBe('1px')
      expect(editorial.boxShadow).toBe('none')

      await page.evaluate(async () => {
        const link = document.getElementById('grammar-link') as HTMLLinkElement
        await new Promise<void>((resolve) => {
          link.onload = () => resolve()
          link.href = '/grammars/workshop.css'
        })
      })
      const workshop = await readCardStyle()
      expect(workshop.borderLeftWidth).toBe('2px')
      expect(workshop.boxShadow).not.toBe('none')

      await page.evaluate(async () => {
        const link = document.getElementById('grammar-link') as HTMLLinkElement
        await new Promise<void>((resolve) => {
          link.onload = () => resolve()
          link.href = '/grammars/console.css'
        })
      })
      const consoleStyle = await readCardStyle()
      expect(consoleStyle.borderLeftWidth).toBe('1px')
      expect(consoleStyle.fontFamily.toLowerCase()).toContain('mono')

      expect(errors).toEqual([])
    }
    finally {
      await browser.close()
      server.stop(true)
    }
  })
})

void grammarCssPath

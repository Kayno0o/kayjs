import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
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

function findChrome(): string | undefined {
  return [process.env.BUN_CHROME_PATH, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome']
    .find((p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p))
}

const isOpen = (page: Page, selector: string): Promise<boolean> => page.locator(selector).evaluate(el => (el as HTMLDialogElement).open)

describe('Dialog and Drawer on the platform (#3686)', () => {
  it('open and close with no JS: commandfor triggers, Esc, the close button and a backdrop click, under the strict CSP', async () => {
    const dir = makeTemp('kay-3686-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Dialog, Drawer } from ${JSON.stringify(UI_ENTRY)}
      export const prerender = true
      export default function Home() {
        return (
          <main>
            <Dialog id="confirm" title="Confirm" triggerLabel="Open dialog"><p>Sure?</p></Dialog>
            <Drawer id="inspector" title="Inspector" triggerLabel="Open drawer" side="left"><p>Details</p></Drawer>
          </main>
        )
      }
    `)
    const app = await testApp({ root: dir, plugins: [ui()] })
    const html = await (await app.get('/')).text()

    expect(html.match(/<script\b[^>]*\bsrc=/g)).toBeNull()
    expect(html).toMatch(/<script type="module" data-kui-fallback="\/_kay\/kui-fallback-[0-9a-f]{8}\.js">/)
    expect(html).toContain('<dialog id="confirm" closedby="any"')

    const chromePath = findChrome()
    if (chromePath === undefined)
      return
    const server = app.app.serve(0)
    const browser = await chromium.launch({ headless: true, executablePath: chromePath })
    try {
      for (const fallback of [false, true]) {
        const page = await browser.newPage()
        const problems: string[] = []
        const fetched: string[] = []
        page.on('pageerror', err => problems.push(err.message))
        page.on('console', msg => msg.type() === 'error' && !msg.text().includes('status of 404') && problems.push(msg.text()))
        page.on('response', res => res.status() >= 400 && !res.url().endsWith('/favicon.ico') && problems.push(`${res.status()} ${res.url()}`))
        page.on('request', req => fetched.push(new URL(req.url()).pathname))
        if (fallback) {
          // What Safari before 26.2 does: no command property, and the click opens nothing by itself.
          await page.addInitScript(() => {
            delete (HTMLButtonElement.prototype as { command?: unknown }).command
            delete (HTMLDialogElement.prototype as { closedBy?: unknown }).closedBy
            addEventListener('click', e => (e.target as Element).closest?.('[commandfor]') && e.preventDefault(), true)
          })
        }
        await page.goto(`http://localhost:${server.port}/`)

        await page.click('[data-ui="dialog-root"] [data-part="trigger"]')
        expect(await isOpen(page, '#confirm')).toBe(true)
        await page.click('#confirm [data-part="close"]')
        expect(await isOpen(page, '#confirm')).toBe(false)
        await page.click('[data-ui="dialog-root"] [data-part="trigger"]')
        await page.mouse.click(5, 5)
        expect(await isOpen(page, '#confirm')).toBe(false)
        await page.click('[data-ui="drawer-root"] [data-part="trigger"]')
        expect(await isOpen(page, '#inspector')).toBe(true)
        await page.keyboard.press('Escape')
        expect(await isOpen(page, '#inspector')).toBe(false)

        expect(problems).toEqual([])
        expect(fetched.some(path => path.includes('kui-fallback-'))).toBe(fallback)
        await page.close()
      }
    }
    finally {
      await browser.close()
      server.stop(true)
    }
  })

  it('ControlledDialog follows its open signal, and the browser closing it sets the signal back', async () => {
    const dir = makeTemp('kay-3686-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/components'), { recursive: true })
    writeFileSync(join(dir, 'src/components/Pinned.tsx'), `
      import { signal } from '@kayjs/kay'
      import { ControlledDialog } from ${JSON.stringify(UI_ENTRY)}
      export function Pinned() {
        const open = signal(false)
        return (
          <div>
            <button id="from-code" type="button" onClick={() => { open.value = true }}>Open from code</button>
            <output id="state">{open.value ? 'open' : 'closed'}</output>
            <ControlledDialog id="pin" open={open} title="Pin"><p>Pin it</p></ControlledDialog>
          </div>
        )
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Pinned } from '../components/Pinned'
      export default function Home() { return <main><Pinned /></main> }
    `)
    const app = await testApp({ root: dir, plugins: [ui()] })
    const chromePath = findChrome()
    if (chromePath === undefined)
      return
    const server = app.app.serve(0)
    const browser = await chromium.launch({ headless: true, executablePath: chromePath })
    try {
      const page = await browser.newPage()
      await page.goto(`http://localhost:${server.port}/`)
      await page.click('#from-code')
      expect(await isOpen(page, '#pin')).toBe(true)
      await page.mouse.click(5, 5)
      expect(await isOpen(page, '#pin')).toBe(false)
      await page.waitForFunction(() => document.getElementById('state')!.textContent === 'closed', undefined, { timeout: 2000 })
      await page.click('#from-code')
      expect(await page.textContent('#state')).toBe('open')
      await page.click('#pin [data-part="close"]')
      await page.waitForFunction(() => document.getElementById('state')!.textContent === 'closed', undefined, { timeout: 2000 })
      expect(await isOpen(page, '#pin')).toBe(false)
    }
    finally {
      await browser.close()
      server.stop(true)
    }
  })
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
    // The speculation rules are data, not JS.
    expect(html.replace(/<script type="speculationrules">[\s\S]*?<\/script>/, '')).not.toContain('<script')
    // Zero inline style="..." attributes — 100% compatible with strict zero-'unsafe-inline' CSP
    expect(html).not.toContain(' style=')
    expect(html).toContain('data-ui="button"')
    expect(html).toContain('data-ui="card"')
    expect(html).toContain('data-ui="switch"')
    expect(html).toContain('data-ui="checkbox"')
    expect(html).toContain('data-ui="radio-group"')
    expect(html).toContain('data-ui="accordion"')
    expect(html).toContain('popovertarget="info-pop"')
    expect(html).toContain('data-layout="stack"')
    expect(html).toContain('data-gap-value="1.5rem"')
    expect(html).toContain('data-min-value="14rem"')
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
      import { Head } from '@kayjs/kay'
      import { Card, CardBody, CardHeader, CommandPalette, DataTable, Dialog, Drawer, Field, Grid, Menu, Popover, Select, Stack, Switch, Tabs, Toaster } from ${JSON.stringify(UI_ENTRY)}
      import { ToastDemo } from '../components/ToastDemo'

      export default async function Demo() {
        return (
          <main>
            <Head>
              <link id="grammar-link" rel="stylesheet" href="/grammars/editorial.css" />
            </Head>
            <Stack id="demo-stack" gap="lg">
              <Grid id="demo-grid" min="sm" gap="1.25rem">
                <Card id="demo-card">
                  <CardHeader>Profile</CardHeader>
                  <CardBody>Hello</CardBody>
                </Card>
              </Grid>
              <Popover id="demo-popover" triggerLabel="Open popover">
                <p>Anchored popover body</p>
              </Popover>
            </Stack>
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
            <Field id="plan-field" label="Plan">
              <Select
                name="plan"
                ariaLabel="Plan"
                defaultValue="free"
                options={[
                  { value: 'free', label: 'Free' },
                  { value: 'pro', label: 'Pro' },
                ]}
              />
            </Field>
            <Switch id="alerts-switch" name="alerts" label="Enable alerts" />
            <ToastDemo />
            <Toaster />
          </main>
        )
      }
    `)

    const app = await testApp({ root: dir, plugins: [ui({ grammar: false })] })
    const server = app.app.serve(0)

    const chromePath = findChrome()
    if (chromePath === undefined) {
      server.stop(true)
      return
    }

    const browser = await chromium.launch({ headless: true, executablePath: chromePath })
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      const cspViolations: string[] = []
      page.on('pageerror', err => errors.push(err.message))
      await page.addInitScript(() => {
        ;(window as unknown as { __csp: string[] }).__csp = []
        document.addEventListener('securitypolicyviolation', (e) => {
          ;(window as unknown as { __csp: string[] }).__csp.push(`${e.effectiveDirective}: ${e.blockedURI || e.sample}`)
        })
      })
      await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'networkidle' })

      // 0. Layout tokens + progressive CSS attr() + native implicit-anchor Popover under strict DEFAULT_CSP
      expect(await page.locator('#demo-stack').evaluate(el => getComputedStyle(el).gap)).toBe('24px')
      expect(await page.locator('#demo-grid').evaluate(el => getComputedStyle(el).gap)).toBe('20px')
      const popTrigger = page.locator('[popovertarget="demo-popover"]')
      await popTrigger.click()
      expect(await page.locator('#demo-popover').isVisible()).toBe(true)
      const popRects = await page.evaluate(() => {
        const trigger = document.querySelector('[popovertarget="demo-popover"]')!.getBoundingClientRect()
        const panel = document.getElementById('demo-popover')!.getBoundingClientRect()
        return { triggerBottom: trigger.bottom, panelTop: panel.top, triggerLeft: trigger.left, panelLeft: panel.left }
      })
      expect(popRects.panelTop).toBeGreaterThanOrEqual(popRects.triggerBottom - 2)
      expect(Math.abs(popRects.panelLeft - popRects.triggerLeft)).toBeLessThan(8)
      await page.keyboard.press('Escape')
      expect(await page.locator('#demo-popover').isVisible()).toBe(false)

      // 1. Dialog open + Escape close
      await page.click('[data-ui="dialog-root"] [data-part="trigger"]')
      expect(await page.locator('dialog[data-ui="dialog"]').evaluate(el => (el as HTMLDialogElement).open)).toBe(true)
      await page.keyboard.press('Escape')
      expect(await page.locator('dialog[data-ui="dialog"]').evaluate(el => (el as HTMLDialogElement).open)).toBe(false)

      // 2. Tabs click + ArrowRight keyboard navigation
      expect(await page.locator('[id$="-panel-one"]').isVisible()).toBe(true)
      expect(await page.locator('[id$="-panel-two"]').isVisible()).toBe(false)
      await page.focus('[id$="-tab-one"]')
      await page.keyboard.press('ArrowRight')
      expect(await page.locator('[id$="-panel-two"]').isVisible()).toBe(true)
      expect(await page.locator('[id$="-tab-two"]').getAttribute('data-state')).toBe('active')

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

      // 4. Select inside <Field> keeps label-for id after hydration + open + pick option updates trigger & hidden form input
      expect(await page.locator('[data-ui="select"] [data-part="trigger"]').getAttribute('id')).toBe('plan-field')
      await page.click('[data-ui="select"] [data-part="trigger"]')
      await page.click('[data-ui="select"] [role="option"]:nth-child(2)')
      expect(await page.locator('[data-ui="select"] [data-part="value"]').textContent()).toBe('Pro')
      expect(await page.locator('input[name="plan"]').inputValue()).toBe('pro')

      // 4a. Switch displays visible keyboard focus indicator on [data-part="track"] (RGAA 10.7)
      await page.locator('[data-ui="select"] [data-part="trigger"]').focus()
      await page.keyboard.press('Tab')
      const switchOutline = await page.locator('[data-ui="switch"] [data-part="track"]').evaluate((el) => {
        const s = getComputedStyle(el)
        return { style: s.outlineStyle, width: Number.parseFloat(s.outlineWidth) }
      })
      expect(switchOutline.style).not.toBe('none')
      expect(switchOutline.width).toBeGreaterThanOrEqual(2)

      // 4b. Once closed, Menu and Select no longer capture arrow keys on the rest of the page
      const arrowPrevented = await page.evaluate(() => {
        const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        document.body.dispatchEvent(e)
        return e.defaultPrevented
      })
      expect(arrowPrevented).toBe(false)

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

      cspViolations.push(...await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp))
      expect(cspViolations).toEqual([])
      expect(errors).toEqual([])
    }
    finally {
      await browser.close()
      server.stop(true)
    }
  })
  it('ui({ emitGrammars: true }) emits all self-contained grammar CSS files into public/grammars/', () => {
    const emitted = new Map<string, string>()
    const plugin = ui({ grammar: false, emitGrammars: true })
    expect(plugin.css).toBeUndefined()
    expect(plugin.build).toBeDefined()
    plugin.build!({
      emitAsset: () => '',
      emitPublic(relPath: string, content: string | Uint8Array) {
        emitted.set(relPath, typeof content === 'string' ? content : new TextDecoder().decode(content))
        return `/${relPath}`
      },
    } as never)

    for (const g of ['bare', 'editorial', 'workshop', 'console', 'soft', 'orbit']) {
      const css = emitted.get(`grammars/${g}.css`)
      expect(css).toBeDefined()
      expect(css).not.toContain('../bare.css')
      expect(css).toContain('[data-ui=')
    }

    const custom = new Map<string, string>()
    ui({ emitGrammars: { dir: 'themes', grammars: ['orbit', 'bare'] } }).build!({
      emitAsset: () => '',
      emitPublic(relPath: string, content: string | Uint8Array) {
        custom.set(relPath, typeof content === 'string' ? content : new TextDecoder().decode(content))
        return `/${relPath}`
      },
    } as never)
    expect([...custom.keys()].sort()).toEqual(['themes/bare.css', 'themes/orbit.css'])
  })
})

void grammarCssPath

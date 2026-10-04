import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

// The fixture is an app installing the library, linked back to this repository by scripts/link-fixture.ts.
const ROOT = join(import.meta.dir, '..')
const site = await testSite({ root: ROOT })

// The element with that id, as rendered.
async function element(path: string, id: string): Promise<string> {
  const html = (await site.visit(path)).html
  const start = html.indexOf(` id="${id}"`)

  expect(start).toBeGreaterThan(-1)

  const open = html.lastIndexOf('<', start)
  const tag = (/^<([a-z]+)/).exec(html.slice(open))![1]!

  return html.slice(open, html.indexOf(`</${tag}>`, start) + tag.length + 3)
}

test('kay check passes on the fixture, the library\'s components it renders and this test included', async () => {
  const check = Bun.spawn([process.execPath, join(ROOT, '..', '..', 'node_modules', '.bin', 'kay'), 'check'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

  expect(await new Response(check.stdout).text() + await new Response(check.stderr).text()).toBe('')
  expect(await check.exited).toBe(0)
}, 60_000)

describe('Icon', () => {
  test('draws a slot through the app\'s settings, which replaced the close icon and kept the rest', async () => {
    expect(await element('/buttons', 'slot')).toContain('m7-2l4 4m0-4l-4 4')
    expect(await element('/buttons', 'accent')).toContain('M12 5v14m-7-7h14')
  })

  test('is decorative unless labelled', async () => {
    expect(await element('/buttons', 'slot')).toContain('aria-hidden="true"')
    expect(await element('/buttons', 'own')).toContain('role="img" aria-label="Home"')
  })
})

describe('Button', () => {
  test('is a button that submits nothing unless asked, with its variant as a class', async () => {
    expect(await element('/buttons', 'plain')).toBe('<button id="plain" type="button" class="btn">Save</button>')
    expect(await element('/buttons', 'accent')).toMatch(/^<button id="accent" type="submit" class="btn btn-accent"><svg[^>]*class="icon">.*<\/svg>Add<\/button>$/)
  })

  test('spins in place of its icon while busy', async () => {
    expect(await element('/buttons', 'busy')).toMatch(/aria-busy="true".*class="icon spinner"/)
  })
})

test('IconButton names its action for screen readers and as its tooltip', async () => {
  expect(await element('/buttons', 'delete')).toMatch(/^<button id="delete" type="button" aria-label="Delete" data-tooltip="Delete" data-size="sm" data-variant="danger" class="icon-btn shell shell-danger">/)
})

test('Toaster is an island rendering an empty manual popover, filled in the browser only', async () => {
  expect(await element('/buttons', 'toasts')).toMatch(/^<div id="toasts"><slot data-component="[^"]*\/toaster\.kay"[^>]*><div class="toaster" popover="manual"><\/div>/)
})

test('Table renders sorted on the server from a static page, its sortable headers buttons and the rest text', async () => {
  // An island's hydration markers left out.
  const table = (await element('/table', 'static')).replaceAll(/<!--[^>]*-->/g, '')
  const cells = [...table.matchAll(/<td class="table-cell" data-align="(\w+)">([^<]*)<\/td>/g)].map(([, align, text]) => `${align}:${text}`)

  expect(cells).toEqual(['start:Earth', 'end:1', 'start:Mars', 'end:2', 'start:Venus', 'end:0'])
  expect(table).toMatch(/<th class="table-head-cell" scope="col" data-align="start" aria-sort="ascending"><button class="table-sort-btn" type="button" data-direction="asc">Name<svg/)
  expect(table).toContain('<th class="table-head-cell" scope="col" data-align="end">Moons</th>')
})

describe('controls', () => {
  const page = async (id: string) => (await element('/controls', id)).replaceAll(/<!--[^>]*-->/g, '')

  test('TabNav links every tab, marking the page on screen as current', async () => {
    const tabs = await page('tabs')

    expect(tabs).toMatch(/<nav aria-label="Sections" class="tab-nav">/)
    expect(tabs).toContain('<a class="tab-nav-link" href="/">Home</a>')
    expect(tabs).toContain('<a class="tab-nav-link" href="/controls" aria-current="page">Controls</a>')
  })

  test('Segmented is a named radio group with its value checked', async () => {
    const range = await page('range')

    expect(range).toMatch(/role="radiogroup" aria-label="Range"/)
    expect([...range.matchAll(/<input class="segmented-input" type="radio" name="range" value="(\w+)"( checked)?/g)].map(([, value, checked]) => `${value}${checked ?? ''}`)).toEqual(['day', 'week checked'])
  })

  test('Toggle is a checkbox with the switch role, on when asked', async () => {
    expect(await page('digest')).toContain('<input name="digest" type="checkbox" role="switch" checked class="toggle-input">')
  })
})

describe('content', () => {
  const page = async (id: string) => (await element('/content', id)).replaceAll(/<!--[^>]*-->/g, '')

  test('Card titles its frame, holds a head block at the far end, and insets its body unless bare', async () => {
    const card = await page('card')

    expect(card).toMatch(/^<section id="card" class="card"><div class="card-head"><h3 class="card-title">Moons<\/h3><span data-tone="success" class="badge"><svg[^>]*class="icon badge-icon">.*<\/svg>3<\/span><\/div><div class="card-body"><p>Phobos and Deimos<\/p><\/div><\/section>$/)
    expect(await page('bare')).toBe('<section id="bare" class="card"><p>Edge to edge</p></section>')
  })

  test('Badge is neutral unless toned, and EmptyState says why there is nothing', async () => {
    expect(await page('badge')).toBe('<span id="badge" data-tone="neutral" class="badge">Draft</span>')
    expect(await page('empty')).toBe('<div id="empty" class="empty-state"><p class="empty-state-title">No moons</p><p class="empty-state-description">Add one to start</p></div>')
  })

  test('Select marks its value\'s option selected, after the empty one', async () => {
    const form = await page('form')

    expect([...form.matchAll(/<option value(?:="(\w*)")?( selected)?>(\w*)<\/option>/g)].map(([, value = '', selected, label]) => `${value}${selected ?? ''}:${label}`)).toEqual([':Any', 'mars:Mars', 'earth selected:Earth'])
  })
})

describe('FormField', () => {
  test('labels its control with what it takes, and shows the message a plain form post was refused with', async () => {
    const field = (await element('/form', 'field')).replaceAll(/<!--[^>]*-->/g, '')

    expect(field).toBe('<div id="field"><label class="form-field"><span class="form-field-head"><span class="label-text">Name<span class="form-field-required">*</span></span></span><input name="name"><span class="form-field-hint">As it shows on the site</span><span class="form-field-issues" aria-live="polite"></span></label></div>')

    const { rename } = await import('../src/routes/form.kay')
    const refused = await site.submit(rename, { name: 'A' }, { from: '/form' })

    expect(refused.html).toContain('<span class="form-field-issue">Two letters at least</span>')
  })
})

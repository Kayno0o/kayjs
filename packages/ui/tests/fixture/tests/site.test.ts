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

    expect(field).toBe('<section id="field"><div class="form-field"><label class="form-field-label"><span class="form-field-head"><span class="label-text">Name<span class="form-field-required" aria-hidden="true">*</span></span></span><input name="name"></label><span class="form-field-hint">As it shows on the site</span><span class="form-field-issues" aria-live="polite"></span></div></section>')

    const { rename } = await import('../src/routes/form.kay')
    const refused = await site.submit(rename, { name: 'A' }, { from: '/form' })

    expect(refused.html).toContain('<span class="form-field-issue">Two letters at least</span>')
  })
})

describe('layout', () => {
  const page = async (id: string) => (await element('/layout', id)).replaceAll(/<!--[^>]*-->/g, '').replaceAll(/<svg[^>]*>.*?<\/svg>/g, '<svg/>')

  test('PageSection titles its stretch and holds an actions block at the end of the head line', async () => {
    expect(await page('section')).toBe('<article id="section"><section class="page-section"><div class="page-section-head"><h2 class="heading-section page-section-title">Moons</h2><a href="/table">New</a></div><p>Phobos</p></section></article>')
  })

  test('CollapsibleSection is a native disclosure, folded when asked, boxed, with its meta before the chevron', async () => {
    expect(await page('collapsed')).toBe('<article id="collapsed"><details data-boxed class="collapsible-section"><summary class="collapsible-section-summary"><span class="heading-section collapsible-section-title">Older</span><span class="collapsible-section-meta"><span data-tone="neutral" class="badge">2</span></span><svg/></summary><div class="collapsible-section-body"><p>Deimos</p></div></details></article>')
  })

  test('Widget heads its body with icon, title and actions, swaps an empty body for its @empty block, and renders nothing empty without one', async () => {
    expect(await page('widget')).toBe('<article id="widget"><div class="widget"><div class="widget-head"><svg/><h2 class="heading-section widget-title">Visits</h2><a href="/content">All</a></div><p>42</p></div></article>')
    expect(await page('empty-widget')).toBe('<article id="empty-widget"><div class="widget"><div class="widget-head"><h2 class="heading-section widget-title">Visits</h2></div><p class="none">No visits yet</p></div></article>')
    expect(await page('hidden-widget')).toBe('<article id="hidden-widget"></article>')
  })

  test('CardRow lays its body between what leads and what trails, its actions last', async () => {
    expect(await page('row')).toBe('<article id="row"><div class="card-row"><span class="dot"></span><div class="card-row-body">Mars</div><span>3 moons</span><div class="card-row-actions"><a href="/form">Edit</a></div></div></article>')
  })
})

describe('data', () => {
  // Islands render inside a `slot` carrying their props, which these tests leave out.
  const page = async (id: string) => (await element('/data', id)).replaceAll(/<!--[^>]*-->/g, '').replaceAll(/<\/?slot[^>]*>/g, '').replaceAll(/<svg[^>]*>.*?<\/svg>/g, '<svg/>')

  test('Stat reads a figure with what it counts', async () => {
    expect(await page('stat')).toBe('<article id="stat"><span class="stat-badge"><svg/><span class="stat-value">12</span><span class="stat-label">moons</span></span></article>')
  })

  test('Meter is a named meter holding its value between 0 and 100, its fill styled apart', async () => {
    expect(await page('meter')).toBe('<article id="meter"><div role="meter" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100" aria-label="Disk" class="meter"><div class="meter-fill bg-error" style="width: 100%"></div></div></article>')
  })

  test('BarList measures each row against the largest, reads its display, and says when it has none', async () => {
    const bars = await page('bars')

    expect([...bars.matchAll(/bar-list-value">([^<]*)<.*?width: (\d+)%/g)].map(match => [match[1], match[2]])).toEqual([['2', '100'], ['one', '50'], ['0', '0']])
    expect(bars).not.toContain('<button')
    expect(await page('no-bars')).toBe('<article id="no-bars"><p class="bar-list-empty">No planets</p></article>')
  })

  test('SiteFavicon shows the site\'s icon, or the globe in a colour of the site\'s own', async () => {
    expect(await page('favicon')).toBe('<article id="favicon"><span class="site-favicon"><img class="site-favicon-img" src="/favicon.png" alt></span></article>')
    expect(await element('/data', 'no-favicon')).toMatch(/<svg[^>]*style="color: #[0-9A-F]{6}"[^>]*class="icon site-favicon-icon"/)
  })

  test('CopyButton is a plain button saying what it copies', async () => {
    expect(await page('copy')).toBe('<article id="copy"><button type="button" class="btn copy-btn">Copy link</button></article>')
  })
})

describe('inputs', () => {
  test('RangeInput names each box and shows its bounds, an open one empty under its limit; MultiSelect posts each value it starts with', async () => {
    const form = (await element('/inputs', 'form')).replaceAll(/<!--[^>]*-->/g, '')

    expect([...form.matchAll(/aria-label="(Hours \w+)" placeholder="(\d+)" min="0" max="24" value="(\d*)"/g)].map(match => match.slice(1))).toEqual([['Hours from', '0', '2'], ['Hours to', '24', '']])
    expect(form).toContain('<span class="multi-select-summary">Mars</span>')
    expect(form).toContain('<input class="multi-select-checkbox" type="checkbox" checked><span class="multi-select-label">Mars</span>')
    expect(form).not.toContain('multi-select-search')
    expect(form).toContain('<input type="hidden" name="planet" value="mars">')
  })
})

describe('drawn ids', () => {
  test('Segmented groups given no name each draw one of their own, shared by their radios', async () => {
    const groups = (await element('/controls', 'unnamed')).split('class="segmented"').slice(1).map(group => [...new Set([...group.matchAll(/type="radio" name="([^"]+)"/g)].map(match => match[1]))])

    expect(groups.map(names => names.length)).toEqual([1, 1])
    expect(groups[0]![0]).not.toBe(groups[1]![0])
  })

  test('a MultiSelect given no id pairs its trigger with a panel of a drawn id', async () => {
    const select = await element('/inputs', 'unnamed')
    const target = (/popovertarget="([^"]+)"/).exec(select)![1]!

    expect(select).toContain(`id="${target}" popover="auto"`)
    expect(select).toContain(`anchor-name: --popover-${target}`)
  })
})

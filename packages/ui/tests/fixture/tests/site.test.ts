import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

// The fixture is an app installing the library, linked back to this repository by scripts/link-fixture.ts.
const ROOT = join(import.meta.dir, '..')
// kay check prints this line on success since kay 1.18, nothing before.
const CLEAN = /^(?:checked with no problems in \d+ ms\n)?$/
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

  expect(await new Response(check.stdout).text() + await new Response(check.stderr).text()).toMatch(CLEAN)
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
    expect(await element('/buttons', 'plain')).toBe('<button id="plain" type="button" class="kui-btn">Save</button>')
    expect(await element('/buttons', 'accent')).toMatch(/^<button id="accent" type="submit" class="kui-btn kui-btn-accent"><svg[^>]*class="kui-icon">.*<\/svg>Add<\/button>$/)
  })

  test('spins in place of its icon while busy', async () => {
    expect(await element('/buttons', 'busy')).toMatch(/aria-busy="true".*class="kui-icon kui-spinner"/)
  })

  test('says whether the disclosure it toggles is showing', async () => {
    expect(await element('/buttons', 'toggle')).toBe('<button id="toggle" disabled type="button" aria-expanded="false" class="kui-btn">More</button>')
  })

  test('is a link looking like one with an href, taking the link\'s attributes', async () => {
    expect(await element('/buttons', 'link')).toMatch(/^<a id="link" href="\/data" target="_blank" class="kui-btn kui-btn-accent"><svg[^>]*class="kui-icon">.*<\/svg>Data<\/a>$/)
  })
})

test('IconButton names its action for screen readers and as its tooltip', async () => {
  expect(await element('/buttons', 'delete')).toMatch(/^<button id="delete" type="button" aria-label="Delete" data-tooltip="Delete" data-size="sm" data-variant="danger" class="kui-icon-btn kui-shell kui-shell-danger">/)
})

test('Toaster is an island rendering an empty manual popover, filled in the browser only', async () => {
  expect(await element('/buttons', 'toasts')).toMatch(/^<div id="toasts"><slot data-component="[^"]*\/toaster\.kay"[^>]*><div class="kui-toaster" popover="manual"><\/div>/)
})

test('Table renders sorted on the server from a static page, its sortable headers buttons and the rest text', async () => {
  // An island's hydration markers left out.
  const table = (await element('/table', 'static')).replaceAll(/<!--[^>]*-->/g, '')
  const cells = [...table.matchAll(/<td class="kui-table-cell" data-align="(\w+)">([^<]*)<\/td>/g)].map(([, align, text]) => `${align}:${text}`)

  expect(cells).toEqual(['start:Earth', 'end:1', 'start:Mars', 'end:2', 'start:Venus', 'end:0'])
  expect(table).toMatch(/<th class="kui-table-head-cell" scope="col" data-align="start" aria-sort="ascending"><button class="kui-table-sort-btn" type="button" data-direction="asc">Name<svg/)
  expect(table).toContain('<th class="kui-table-head-cell" scope="col" data-align="end">Moons</th>')
})

describe('controls', () => {
  const page = async (id: string) => (await element('/controls', id)).replaceAll(/<!--[^>]*-->/g, '')

  test('TabNav links every tab, marking the page on screen as current', async () => {
    const tabs = await page('tabs')

    expect(tabs).toMatch(/<nav aria-label="Sections" class="kui-tab-nav">/)
    expect(tabs).toContain('<a class="kui-tab-nav-link" href="/">Home</a>')
    expect(tabs).toContain('<a class="kui-tab-nav-link" href="/controls" aria-current="page">Controls</a>')
  })

  test('Segmented is a named radio group with its value checked', async () => {
    const range = await page('range')

    expect(range).toMatch(/role="radiogroup" aria-label="Range"/)
    expect([...range.matchAll(/<input class="kui-segmented-input" type="radio" name="range" value="(\w+)"( checked)?/g)].map(([, value, checked]) => `${value}${checked ?? ''}`)).toEqual(['day', 'week checked'])
  })

  test('Toggle is a checkbox with the switch role, on when asked', async () => {
    expect(await page('digest')).toContain('<input name="digest" type="checkbox" role="switch" checked class="kui-toggle-input">')
  })
})

describe('content', () => {
  const page = async (id: string) => (await element('/content', id)).replaceAll(/<!--[^>]*-->/g, '')

  test('Card titles its frame, holds a head block at the far end, and insets its body unless bare', async () => {
    const card = await page('card')

    expect(card).toMatch(/^<section id="card" class="kui-card"><div class="kui-card-head"><h3 class="kui-card-title">Moons<\/h3><span data-tone="success" class="kui-badge"><svg[^>]*class="kui-icon kui-badge-icon">.*<\/svg>3<\/span><\/div><div class="kui-card-body"><p>Phobos and Deimos<\/p><\/div><\/section>$/)
    expect(await page('bare')).toBe('<section id="bare" class="kui-card"><p>Edge to edge</p></section>')
  })

  test('Carousel shows its slide, hides the rest from the focus and screen readers, and names each in the app\'s words', async () => {
    const carousel = (await page('carousel')).replaceAll(/<\/?slot[^>]*>/g, '')

    expect(carousel).toContain('<section aria-roledescription="carousel" aria-label="Galerie photos" class="kui-carousel"><div class="kui-carousel-viewport" style="aspect-ratio: 4 / 3" aria-live="polite">')
    expect([...carousel.matchAll(/aria-label="(\d sur 2)"( aria-hidden="true" inert)? style="transform: translateX\((-?\d+)%\)"/g)].map(([, name, hidden, shift]) => [name, Boolean(hidden), shift])).toEqual([['1 sur 2', true, '-100'], ['2 sur 2', false, '0']])
    expect([...carousel.matchAll(/class="kui-carousel-dot" type="button" aria-label="([^"]*)"( aria-current="true")?/g)].map(([, name, current]) => [name, Boolean(current)])).toEqual([['Aller à l\'image 1', false], ['Aller à l\'image 2', true]])
  })

  test('Carousel draws no controls for a single slide', async () => {
    const lone = await page('lone-slide')

    expect(lone).toContain('aria-label="Slide 1 of 1" style="transform: translateX(0%)"')
    expect(lone).not.toContain('kui-carousel-controls')
  })

  test('Badge is neutral unless toned, and EmptyState says why there is nothing', async () => {
    expect(await page('badge')).toBe('<span id="badge" data-tone="neutral" class="kui-badge">Draft</span>')
    expect(await page('empty')).toBe('<div id="empty" class="kui-empty-state"><p class="kui-empty-state-title">No moons</p><p class="kui-empty-state-description">Add one to start</p></div>')
  })

  test('EmptyState holds an @actions block below its description, and none without one', async () => {
    expect(await page('empty-action')).toContain('<p class="kui-empty-state-title">No rockets</p><div class="kui-empty-state-actions"><a class="go" href="/paging">Build one</a></div>')
    expect(await page('empty')).not.toContain('kui-empty-state-actions')
  })

  test('Select marks its value\'s option selected, after the empty one', async () => {
    const form = await page('form')

    expect([...form.matchAll(/<option value(?:="(\w*)")?( selected)?>(\w*)<\/option>/g)].map(([, value = '', selected, label]) => `${value}${selected ?? ''}:${label}`)).toEqual([':Any', 'mars:Mars', 'earth selected:Earth'])
  })
})

describe('FormField', () => {
  test('labels its control with what it takes, and shows the message a plain form post was refused with', async () => {
    const field = (await element('/form', 'field')).replaceAll(/<!--[^>]*-->/g, '')

    expect(field).toBe('<section id="field"><div class="kui-form-field"><label class="kui-form-field-label"><span class="kui-form-field-head"><span class="kui-label-text">Name<span class="kui-form-field-required" aria-hidden="true">*</span></span></span><input name="name"></label><span class="kui-form-field-hint">As it shows on the site</span><span class="kui-form-field-issues" aria-live="polite"></span></div></section>')

    const { rename } = await import('../src/routes/form.kay')
    const refused = await site.submit(rename, { name: 'A' }, { from: '/form' })

    expect(refused.html).toContain('<span class="kui-form-field-issue">Two letters at least</span>')
  })
})

describe('layout', () => {
  const page = async (id: string) => (await element('/layout', id)).replaceAll(/<!--[^>]*-->/g, '').replaceAll(/<svg[^>]*>.*?<\/svg>/g, '<svg/>')

  test('SiteNav marks the page on screen and the section holding it, its links folded behind a closed toggle they are anchored to', async () => {
    const nav = (await page('site-nav')).replaceAll(/<\/?slot[^>]*>/g, '')

    expect(nav).toContain('<nav aria-label="Main" class="kui-site-nav"><button aria-expanded="false" aria-controls="main-links" style="anchor-name: --kui-site-nav-main-links" type="button" aria-label="Ouvrir le menu"')
    expect(nav).toContain('<ul class="kui-site-nav-list" id="main-links" style="position-anchor: --kui-site-nav-main-links">')
    expect([...nav.matchAll(/<a class="kui-site-nav-link" href="([^"]*)"(?: aria-current="(\w+)")?>/g)].map(([, href, current]) => `${href}${current ? ` ${current}` : ''}`)).toEqual(['/', '/chart', '/charts true', '/charts/moons page', '/data'])
  })

  test('PageSection titles its stretch and holds an actions block at the end of the head line', async () => {
    expect(await page('section')).toBe('<article id="section"><section class="kui-page-section"><div class="kui-page-section-head"><h2 class="kui-heading-section kui-page-section-title">Moons</h2><a href="/table">New</a></div><p>Phobos</p></section></article>')
  })

  test('CollapsibleSection is a native disclosure, folded when asked, boxed, with its meta before the chevron', async () => {
    expect(await page('collapsed')).toBe('<article id="collapsed"><details data-boxed class="kui-collapsible-section"><summary class="kui-collapsible-section-summary"><span class="kui-heading-section kui-collapsible-section-title">Older</span><span class="kui-collapsible-section-meta"><span data-tone="neutral" class="kui-badge">2</span></span><svg/></summary><div class="kui-collapsible-section-body"><p>Deimos</p></div></details></article>')
  })

  test('Widget heads its body with icon, title and actions, swaps an empty body for its @empty block, and renders nothing empty without one', async () => {
    expect(await page('widget')).toBe('<article id="widget"><div class="kui-widget"><div class="kui-widget-head"><svg/><h2 class="kui-heading-section kui-widget-title">Visits</h2><a href="/content">All</a></div><p>42</p></div></article>')
    expect(await page('empty-widget')).toBe('<article id="empty-widget"><div class="kui-widget"><div class="kui-widget-head"><h2 class="kui-heading-section kui-widget-title">Visits</h2></div><p class="none">No visits yet</p></div></article>')
    expect(await page('hidden-widget')).toBe('<article id="hidden-widget"></article>')
  })

  test('CardRow lays its body between what leads and what trails, its actions last', async () => {
    expect(await page('row')).toBe('<article id="row"><div class="kui-card-row"><span class="dot"></span><div class="kui-card-row-body">Mars</div><span>3 moons</span><div class="kui-card-row-actions"><a href="/form">Edit</a></div></div></article>')
  })
})

describe('data', () => {
  // Islands render inside a `slot` carrying their props, which these tests leave out.
  const page = async (id: string) => (await element('/data', id)).replaceAll(/<!--[^>]*-->/g, '').replaceAll(/<\/?slot[^>]*>/g, '').replaceAll(/<svg[^>]*>.*?<\/svg>/g, '<svg/>')

  test('Stat reads a figure with what it counts', async () => {
    expect(await page('stat')).toBe('<article id="stat"><span class="kui-stat-badge"><svg/><span class="kui-stat-value">12</span><span class="kui-stat-label">moons</span></span></article>')
  })

  test('Meter is a named meter holding its value between 0 and 100, its fill styled apart', async () => {
    expect(await page('meter')).toBe('<article id="meter"><div role="meter" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100" aria-label="Disk" class="kui-meter"><div class="kui-meter-fill bg-kui-error" style="width: 100%"></div></div></article>')
  })

  test('BarList measures each row against the largest, reads its display, and says when it has none', async () => {
    const bars = await page('bars')

    expect([...bars.matchAll(/bar-list-value">([^<]*)<.*?width: (\d+)%/g)].map(match => [match[1], match[2]])).toEqual([['2', '100'], ['one', '50'], ['0', '0']])
    expect(bars).not.toContain('<button')
    expect(await page('no-bars')).toBe('<article id="no-bars"><p class="kui-bar-list-empty">No planets</p></article>')
  })

  test('SiteFavicon shows the site\'s icon, or the globe in a colour of the site\'s own', async () => {
    expect(await page('favicon')).toBe('<article id="favicon"><span class="kui-site-favicon"><img class="kui-site-favicon-img" src="/favicon.png" alt></span></article>')
    expect(await element('/data', 'no-favicon')).toMatch(/<svg[^>]*style="color: #[0-9A-F]{6}"[^>]*class="kui-icon kui-site-favicon-icon"/)
  })

  test('Rating reads its value out of its max, filling that share of the stars, kept between none and all', async () => {
    const stars = (count: number) => `<span class="kui-rating-stars">${'<svg/>'.repeat(count)}</span>`

    expect(await page('rating')).toBe(`<article id="rating"><span role="img" aria-label="4.6 out of 5" class="kui-rating">${stars(5)}<span class="kui-rating-fill" style="width: 92%">${stars(5)}</span></span></article>`)
    expect(await page('rating-out')).toBe(`<article id="rating-out"><span role="img" aria-label="Top marks" class="kui-rating">${stars(4)}<span class="kui-rating-fill" style="width: 100%">${stars(4)}</span></span></article>`)
    expect(await page('rating-below')).toContain('style="width: 0%"')
    expect(await page('rating-nan')).toContain('style="width: 0%"')
    expect(await page('rating-none')).toBe(`<article id="rating-none"><span role="img" aria-label="3 out of 0" class="kui-rating">${stars(0)}<span class="kui-rating-fill" style="width: 0%">${stars(0)}</span></span></article>`)
  })

  test('CopyButton is a plain button saying what it copies', async () => {
    expect(await page('copy')).toBe('<article id="copy"><button type="button" class="kui-btn kui-copy-btn">Copy link</button></article>')
  })
})

describe('inputs', () => {
  test('RangeInput names each box and shows its bounds, an open one empty under its limit; MultiSelect posts each value it starts with', async () => {
    const form = (await element('/inputs', 'form')).replaceAll(/<!--[^>]*-->/g, '')

    expect([...form.matchAll(/aria-label="(Hours \w+)" placeholder="(\d+)" min="0" max="24" value="(\d*)"/g)].map(match => match.slice(1))).toEqual([['Hours from', '0', '2'], ['Hours to', '24', '']])
    expect(form).toContain('<span class="kui-multi-select-summary">Mars</span>')
    expect(form).toContain('<input class="kui-multi-select-checkbox" type="checkbox" checked><span class="kui-multi-select-label">Mars</span>')
    expect(form).not.toContain('kui-multi-select-search')
    expect(form).toContain('<input type="hidden" name="planet" value="mars">')
  })
})

describe('drawn ids', () => {
  test('Segmented groups given no name each draw one of their own, shared by their radios', async () => {
    const groups = (await element('/controls', 'unnamed')).split('class="kui-segmented"').slice(1).map(group => [...new Set([...group.matchAll(/type="radio" name="([^"]+)"/g)].map(match => match[1]))])

    expect(groups.map(names => names.length)).toEqual([1, 1])
    expect(groups[0]![0]).not.toBe(groups[1]![0])
  })

  test('a MultiSelect given no id pairs its trigger with a panel of a drawn id', async () => {
    const select = await element('/inputs', 'unnamed')
    const target = (/popovertarget="([^"]+)"/).exec(select)![1]!

    expect(select).toContain(`id="${target}" popover="auto"`)
    expect(select).toContain(`anchor-name: --kui-popover-${target}`)
  })
})

describe('Tabs', () => {
  test('pairs each tab with its panel through drawn ids, and shows the starting tab\'s panel alone', async () => {
    const tabs = await element('/tabs', 'planets')
    const pairs = [...tabs.matchAll(/role="tab" id="([^"]+)" aria-controls="([^"]+)" aria-selected="(\w+)" tabindex="(-?\d)"/g)].map(match => match.slice(1))
    const panels = [...tabs.matchAll(/role="tabpanel" id="([^"]+)" aria-labelledby="([^"]+)" tabindex="0"( hidden)?/g)].map(match => match.slice(1))

    expect(pairs.map(([, , selected, index]) => [selected, index])).toEqual([['false', '-1'], ['true', '0'], ['false', '-1']])
    expect(panels.map(([panel, tab, hidden]) => [panel, tab, Boolean(hidden)])).toEqual(pairs.map(([tab, panel], index) => [panel, tab, index !== 1]))
    expect(new Set(pairs.flatMap(([tab, panel]) => [tab, panel])).size).toBe(6)
  })
})

describe('charts', () => {
  const page = async (id: string) => (await element('/charts', id)).replaceAll(/<!--[^>]*-->/g, '').replaceAll(/<\/?slot[^>]*>/g, '')

  test('LineChart renders its frame and legend on the server, leaving the drawing to the browser', async () => {
    expect(await page('line')).toBe('<article id="line"><div role="img" aria-label="Visits" class="kui-line-chart"><div class="kui-line-chart-frame"><div class="kui-line-chart-plot"></div><div class="kui-line-chart-overlay" role="presentation"></div></div><ul class="kui-line-chart-legend"><li class="kui-line-chart-legend-item"><span class="kui-line-chart-swatch" style="background-color: var(--kui-chart-1)"></span>Visits</li><li class="kui-line-chart-legend-item"><span class="kui-line-chart-swatch" style="background-color: red"></span>Sales</li></ul></div></article>')
  })

  test('ScatterChart places dots, ticks, guides and corners along its axes, a dot\'s size following its weight', async () => {
    const scatter = await page('scatter')

    expect([...scatter.matchAll(/aria-label="(\w+)" data-tooltip="([^"]+)" style="([^"]+)"/g)].map(match => match.slice(1))).toEqual([
      ['Hades', 'Hades', 'left: 25%; bottom: 100%; --kui-dot-size: 1.75rem'],
      ['Celeste', 'Celeste, 30h', 'left: 75%; bottom: 0%; --kui-dot-size: 1.1875rem'],
    ])
    expect(scatter).toContain('<span class="kui-scatter-chart-grid" data-axis="x" style="left: 50%"><span class="kui-scatter-chart-tick">20h</span></span><span class="kui-scatter-chart-guide" data-axis="y" style="bottom: 50%"></span><span class="kui-scatter-chart-guide" data-axis="x" style="left: 50%"></span><span class="kui-scatter-chart-corner" data-corner="topRight">Long and loved</span>')
    expect(scatter).not.toContain('<button')
    expect(await page('no-scatter')).toBe('<article id="no-scatter"><p class="kui-scatter-chart-empty">No games</p></article>')
  })

  test('ContributionGraph shades each day by how full it was, marks today, and names the months over their weeks', async () => {
    const graph = await page('graph')
    const cells = [...graph.matchAll(/<span class="kui-contribution-cell" role="img" aria-label="([^"]+)"[^>]*?( data-today)? style="([^"]+)"/g)].map(match => [match[1], Boolean(match[2]), match[3]])

    expect(cells.slice(0, 3)).toEqual([
      ['3 commits · 2026-08-31', false, 'grid-row: 2; grid-column: 1'],
      ['2026-09-01', false, 'background-color: color-mix(in srgb, var(--color-kui-accent) 63%, transparent); grid-row: 3; grid-column: 1'],
      ['2026-09-02', true, 'background-color: color-mix(in srgb, var(--color-kui-accent) 100%, transparent); grid-row: 4; grid-column: 1'],
    ])
    expect(cells.at(-1)?.[2]).toContain('grid-row: 8; grid-column: 3')
    expect(graph).toMatch(/^<article id="graph"><div class="kui-contribution-graph kui-contribution-graph-months"><span class="kui-contribution-month" aria-hidden="true" style="grid-column: 1">Sep\w*<\/span><span class="kui-contribution-cell"/)
  })
})

describe('Pagination', () => {
  test('links each page through the query, the current one marked, the steps past the ends disabled', async () => {
    const first = await element('/paging', 'first')

    expect(first).toContain('<nav aria-label="Pagination" class="kui-pagination">')
    expect(first).toContain('<span class="kui-pagination-step">Previous</span>')
    expect(first).toContain('<a class="kui-pagination-page" href="/posts?tag=kay&amp;page=2">2</a>')
    expect(first).toContain('<a class="kui-pagination-page" href="/posts?tag=kay" aria-current="page">1</a>')
    expect(first).toContain('<a class="kui-pagination-page" href="/posts?tag=kay&amp;page=3">3</a>')
    expect(first).toContain('<a class="kui-pagination-step" href="/posts?tag=kay&amp;page=2" rel="next">Next</a>')
  })

  test('follows the page the URL asks for, with gaps around it, and draws nothing for a single page', async () => {
    const middle = (await element('/paging?page=10', 'middle')).replaceAll(/<!--[^>]*-->/g, '')

    expect(middle).toContain('aria-label="Posts"')
    expect([...middle.matchAll(/class="kui-pagination-(page|gap)"[^>]*>([^<]*)</g)].map(([, , text]) => text)).toEqual(['1', '…', '9', '10', '11', '…', '20'])
    expect(middle).toContain('<a class="kui-pagination-step" href="/paging?page=9" rel="prev">Précédent</a>')
    expect(middle).toContain('href="/paging?page=10" aria-current="page"')
    expect(await element('/paging', 'single')).not.toContain('kui-pagination')
  })

  test('takes a page kay\'s paginate() gave, linking each page at the path it names', async () => {
    const paged = (await element('/paging', 'paged')).replaceAll(/<!--[^>]*-->/g, '')

    expect(paged).toContain('<a class="kui-pagination-step" href="/blog" rel="prev">Previous</a>')
    expect(paged).toContain('<a class="kui-pagination-page" href="/blog/2" aria-current="page">2</a>')
    expect(paged).toContain('<a class="kui-pagination-step" href="/blog/3" rel="next">Next</a>')
  })

  test('shows a page past the ends, or none at all, as the nearest that exists', async () => {
    const strip = (html: string) => html.replaceAll(/<!--[^>]*-->/g, '')

    expect(strip(await element('/paging?page=50', 'middle'))).toContain('href="/paging?page=20" aria-current="page"')
    expect(strip(await element('/paging?page=50', 'middle'))).toContain('<span class="kui-pagination-step">Suivant</span>')
    expect(strip(await element('/paging?page=abc', 'middle'))).toContain('href="/paging" aria-current="page"')
  })
})

test('QrCode draws its value as an SVG image named for screen readers, drawn as its options say', async () => {
  const svg = async (id: string) => decodeURIComponent((/src="data:image\/svg\+xml,([^"]+)"/).exec(await element('/paging', id))![1]!)

  expect(await element('/paging', 'qr')).toContain('alt="kaynooo.fr" width="160" height="160" class="kui-qr-code"')
  expect(await svg('qr')).toStartWith('<svg')
  expect(await svg('qr')).not.toBe(await svg('qr-other'))
  expect(await svg('qr-styled')).toContain('#7aa2f7')
  expect(await element('/paging', 'qr-other')).not.toContain('width=')
})

test('QrCode with inline draws the SVG in the page, so CSS colours resolve, and hides an unlabeled code from assistive technology', async () => {
  const inline = await element('/paging', 'qr-inline')

  expect(inline).not.toContain('<img')
  expect(inline).toContain('<div role="img" aria-label="Inline" style="width: 120px; height: 120px" class="kui-qr-code"><svg')
  expect(inline).toContain('currentColor')
  expect(inline).toContain('var(--color-accent)')
  expect(await element('/paging', 'qr-decor')).toContain('alt aria-hidden="true"')
  expect(await element('/paging', 'qr-decor-inline')).toContain('aria-hidden="true"')
  expect(await element('/paging', 'qr-decor-inline')).not.toContain('role=')
})

import type { Found } from 'kay/test'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

// The fixture is an app installing the library, linked back to the library by the repository root's scripts/link-fixture.ts.
const ROOT = join(import.meta.dir, '..')
// kay check prints this line on success since kay 1.18, nothing before.
const CLEAN = /^(?:checked with no problems in \d+ ms\n)?$/
const KUI_CLASS = /^kui-[\w-]+/
const site = await testSite({ root: ROOT })

// Each page is fetched once, whichever tests read it.
const visits = new Map<string, ReturnType<typeof site.visit>>()

async function visit(path: string) {
  if (!visits.has(path))
    visits.set(path, site.visit(path))

  return visits.get(path)!
}

// The elements a selector matches on a page.
async function find(path: string, selector: string) {
  return (await visit(path)).find(selector)
}

// The one element a selector matches on a page.
async function one(path: string, selector: string) {
  const found = await find(path, selector)

  expect(found).toHaveLength(1)

  return found[0]!
}

// An attribute of a found element, `null` when it lacks it.
function attr(found: Found, name: string): string | null {
  return found.attributes[name] ?? null
}

// The attributes of the elements a selector matches, those listed only, `null` for one an element lacks.
async function attributes(path: string, selector: string, names: string[]): Promise<Record<string, string | null>[]> {
  return (await find(path, selector)).map(found => Object.fromEntries(names.map(name => [name, attr(found, name)])))
}

// The element with that id, as rendered.
async function element(path: string, id: string): Promise<string> {
  const html = (await visit(path)).html
  const start = html.indexOf(` id="${id}"`)

  expect(start).toBeGreaterThan(-1)

  const open = html.lastIndexOf('<', start)
  const tag = (/^<([a-z]+)/).exec(html.slice(open))![1]!

  // The element ends at the close tag that brings its own tag's nesting back to zero.
  const tags = new RegExp(`<(/?)${tag}[\\s>]`, 'g')
  let depth = 0

  tags.lastIndex = open
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[1] === '/' ? -1 : 1

    if (depth === 0)
      return html.slice(open, match.index + tag.length + 3)
  }

  throw new Error(`No end to #${id}`)
}

test('kay check passes on the fixture, the library\'s components it renders and this test included', async () => {
  const check = Bun.spawn([process.execPath, join(ROOT, '..', '..', '..', '..', 'src', 'cli.ts'), 'check'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

  expect(await new Response(check.stdout).text() + await new Response(check.stderr).text()).toMatch(CLEAN)
  expect(await check.exited).toBe(0)
}, 60_000)

describe('Icon', () => {
  test('draws a slot through the app\'s settings, which replaced the close icon and kept the rest', async () => {
    expect((await one('/buttons', '#slot')).html).toContain('m7-2l4 4m0-4l-4 4')
    expect((await one('/buttons', '#accent')).html).toContain('M12 5v14m-7-7h14')
  })

  test('is decorative unless labelled', async () => {
    expect(await attributes('/buttons', '#slot, #own', ['aria-hidden', 'role', 'aria-label'])).toEqual([
      { 'aria-hidden': 'true', 'role': null, 'aria-label': null },
      { 'aria-hidden': null, 'role': 'img', 'aria-label': 'Home' },
    ])
  })
})

test('Button is a button that submits nothing unless asked, a link with an href, and says what it toggles and when it is busy', async () => {
  const names = ['type', 'href', 'target', 'disabled', 'aria-expanded', 'aria-busy']
  const cases: Record<string, [tag: string, text: string, attributes: Record<string, string | null>]> = {
    plain: ['button', 'Save', { 'type': 'button', 'href': null, 'target': null, 'disabled': null, 'aria-expanded': null, 'aria-busy': null }],
    accent: ['button', 'Add', { 'type': 'submit', 'href': null, 'target': null, 'disabled': null, 'aria-expanded': null, 'aria-busy': null }],
    busy: ['button', 'Saving', { 'type': 'button', 'href': null, 'target': null, 'disabled': null, 'aria-expanded': null, 'aria-busy': 'true' }],
    toggle: ['button', 'More', { 'type': 'button', 'href': null, 'target': null, 'disabled': '', 'aria-expanded': 'false', 'aria-busy': null }],
    link: ['a', 'Data', { 'type': null, 'href': '/data', 'target': '_blank', 'disabled': null, 'aria-expanded': null, 'aria-busy': null }],
  }

  for (const [id, [tag, text, expected]] of Object.entries(cases)) {
    const found = await one('/buttons', `#${id}`)

    expect({ id, tag: found.tag, text: found.text, ...Object.fromEntries(names.map(name => [name, attr(found, name)])) }).toEqual({ id, tag, text, ...expected })
  }

  // A busy button swaps its icon for a spinner rather than adding one.
  expect((await find('/buttons', '#busy svg')).map(icon => icon.attributes.class)).toEqual(['kui-icon kui-spinner'])
})

test('IconButton names its action for screen readers and as its tooltip', async () => {
  const { attributes: found } = await one('/buttons', '#delete')

  expect([found['aria-label'], found['data-tooltip']]).toEqual(['Delete', 'Delete'])
})

test('Toaster is an island rendering a status region, an alert region and an empty manual popover, filled in the browser only', async () => {
  expect(await attributes('/buttons', '#toasts [role], #toasts [popover]', ['role', 'popover'])).toEqual([
    { role: 'status', popover: null },
    { role: 'alert', popover: null },
    { role: null, popover: 'manual' },
  ])
  expect((await one('/buttons', '#toasts [popover]')).text).toBe('')
})

describe('Table on the server', () => {
  test('renders sorted from a static page, its sortable headers buttons and the rest text, stacked when narrow unless it scrolls', async () => {
    const head = (await find('/table', '#static th[scope="col"]')).map(found => [found.text, attr(found, 'aria-sort')])

    expect((await find('/table', '#static .kui-table-cell-body')).map(cell => cell.text)).toEqual(['Earth', '1', 'Mars', '2', 'Venus', '0'])
    expect(head).toEqual([['Name', 'ascending'], ['Moons', null]])
    expect((await find('/table', '#static th button')).map(button => button.text)).toEqual(['Name'])

    // Stacked, each cell is labelled by its header; scrolling, the table keeps its header row alone.
    expect((await attributes('/table', '#static .kui-table-wrap, #scrolling .kui-table-wrap', ['data-narrow']))).toEqual([{ 'data-narrow': 'stack' }, { 'data-narrow': 'scroll' }])
    expect((await find('/table', '#static .kui-table-cell-label')).map(label => label.text)).toEqual(['Name', 'Moons', 'Name', 'Moons', 'Name', 'Moons'])
    expect(await find('/table', '#scrolling .kui-table-cell-label')).toEqual([])
  })

  test('renders its selection: a box per row labelled by it, the picked ones marked, and the count over the select-all box', async () => {
    const rows = await find('/table', '#selectable tbody tr')

    expect((await visit('/table')).text('#selectable')).toContain('1 selected')
    expect((await find('/table', '#selectable .kui-table-select-cell')).map(cell => cell.text)).toContain('Select all')
    expect((await find('/table', '#selectable tbody input')).map(box => box.attributes['aria-label'])).toEqual(['Select Mars', 'Select Earth', 'Select Venus'])
    expect(rows.map(row => attr(row, 'data-selected'))).toEqual([null, '', null])
    expect((await attributes('/table', '#selectable tr[data-selected] input', ['aria-label', 'checked']))).toEqual([{ 'aria-label': 'Select Earth', 'checked': '' }])
  })

  test('filters by the text its query param holds, shown in its search box', async () => {
    const page = '/table?q=EAR'

    expect((await attributes(page, '#filtered input[type="search"]', ['value']))).toEqual([{ value: 'EAR' }])
    expect((await find(page, '#filtered .kui-table-cell-body')).map(cell => cell.text).filter(text => (/\D/).test(text))).toEqual(['Earth'])
  })
})

describe('controls', () => {
  test('TabNav links every tab, marking the page on screen as current', async () => {
    expect((await attributes('/controls', '#tabs nav', ['aria-label']))).toEqual([{ 'aria-label': 'Sections' }])
    expect((await find('/controls', '#tabs a')).map(link => [link.attributes.href, link.text, attr(link, 'aria-current')])).toEqual([['/', 'Home', null], ['/controls', 'Controls', 'page']])
  })

  test('Segmented is a named radio group with its value checked', async () => {
    const radios = await find('/controls', '#range input[type="radio"]')

    expect((await attributes('/controls', '#range [role="radiogroup"]', ['aria-label']))).toEqual([{ 'aria-label': 'Range' }])
    expect(radios.map(radio => [radio.attributes.name, radio.attributes.value, attr(radio, 'checked')])).toEqual([['range', 'day', null], ['range', 'week', '']])
  })

  test('Toggle is a checkbox with the switch role, on when asked', async () => {
    expect((await attributes('/controls', '#digest input', ['type', 'role', 'checked', 'name']))).toEqual([{ type: 'checkbox', role: 'switch', checked: '', name: 'digest' }])
  })
})

describe('breadcrumb', () => {
  test('Breadcrumb is a named nav listing the trail, the last item the current page and no link', async () => {
    expect(await attributes('/breadcrumb', '#long nav', ['aria-label'])).toEqual([{ 'aria-label': 'Trail' }])
    expect((await find('/breadcrumb', '#long li')).map(item => [item.text, attr(item, 'data-middle')])).toEqual([['Home', null], ['…', null], ['Moons', ''], ['Jupiter', null], ['Europa', null]])
    expect((await find('/breadcrumb', '#long a')).map(link => link.attributes.href)).toEqual(['/', '/moons', '/moons/jupiter'])
    expect((await find('/breadcrumb', '#long [aria-current]')).map(found => [found.text, found.tag])).toEqual([['Europa', 'span']])
  })

  test('a trail of three items has no ellipsis, and only a structured one writes the BreadcrumbList', async () => {
    expect((await find('/breadcrumb', '#short .kui-breadcrumb-more'))).toEqual([])

    const scripts = await find('/breadcrumb', 'script[type="application/ld+json"]')

    expect(scripts).toHaveLength(1)
    expect(JSON.parse(scripts[0]!.text)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      'itemListElement': [
        { '@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': 'https://example.com/' },
        { '@type': 'ListItem', 'position': 2, 'name': 'Moons', 'item': 'https://example.com/moons' },
        { '@type': 'ListItem', 'position': 3, 'name': 'Jupiter', 'item': 'https://example.com/moons/jupiter' },
        { '@type': 'ListItem', 'position': 4, 'name': 'Europa' },
      ],
    })
  })
})

describe('layout', () => {
  test('AppHeader is a header holding its brand, one named nav and its end area, sticky unless told not to', async () => {
    expect((await find('/layout', '#app-header header > .kui-app-header-brand, #app-header header .kui-site-nav, #app-header header > .kui-app-header-end')).map(found => found.attributes.class?.match(KUI_CLASS)?.[0])).toEqual(['kui-app-header-brand', 'kui-site-nav', 'kui-app-header-end'])
    expect(await attributes('/layout', '#app-header header, #app-header-bare header', ['data-sticky'])).toEqual([{ 'data-sticky': '' }, { 'data-sticky': null }])
    expect(await attributes('/layout', '#app-header nav', ['aria-label'])).toEqual([{ 'aria-label': 'Site' }])
    expect((await find('/layout', '#app-header-bare header .kui-app-header-brand, #app-header-bare header .kui-app-header-end'))).toEqual([])
  })

  test('AppHeader marks the current link and draws a link\'s icon beside its escaped label', async () => {
    expect(await attributes('/layout', '#app-header .kui-site-nav-link', ['href', 'aria-current'])).toEqual([{ 'href': '/', 'aria-current': null }, { 'href': '/data', 'aria-current': 'page' }])
    expect((await find('/layout', '#app-header .kui-site-nav-link')).map(found => found.text)).toEqual(['Home', '<b>Data</b>'])
    expect(await attributes('/layout', '#app-header .kui-site-nav-link svg', ['aria-hidden'])).toEqual([{ 'aria-hidden': 'true' }])
  })
})

describe('content', () => {
  test('Card titles its frame at the level given, holds a head block at the far end, and insets its body unless bare', async () => {
    expect((await find('/content', '#card .kui-card-head > *')).map(found => [found.tag, found.text])).toEqual([['h3', 'Moons'], ['span', '3']])
    expect((await attributes('/content', '#card .kui-badge', ['data-tone']))).toEqual([{ 'data-tone': 'success' }])
    expect((await one('/content', '#card .kui-card-body')).text).toBe('Phobos and Deimos')
    expect(await find('/content', '#bare .kui-card-body')).toEqual([])
    expect((await one('/content', '#bare p')).text).toBe('Edge to edge')
    expect((await one('/content', '#outlined .kui-card-title')).tag).toBe('h2')
    expect((await find('/content', '#page .kui-card-head > *')).map(found => [found.tag, found.text])).toEqual([['h1', '<i>Sign in</i>'], ['span', '1']])
    expect(await find('/content', '#untitled h1, #untitled h2, #untitled h3, #untitled .kui-card-head')).toEqual([])
  })

  test('Notice is a status, or an alert for a danger, drawn as a box or as a bare line', async () => {
    expect(await attributes('/content', '#notice [role], #notice-error [role]', ['role', 'data-tone', 'data-compact'])).toEqual([
      { 'role': 'status', 'data-tone': 'info', 'data-compact': null },
      { 'role': 'alert', 'data-tone': 'danger', 'data-compact': '' },
    ])
    expect((await one('/content', '#notice-error a')).attributes.href).toBe('/data')
  })

  test('Avatar shows its picture as decoration, or the initial on a seeded colour, named when given a label', async () => {
    expect(await attributes('/content', '#avatar img', ['src', 'alt', 'loading'])).toEqual([{ src: '/ada.png', alt: '', loading: 'lazy' }])
    expect(await attributes('/content', '#avatar-initial [role]', ['role', 'aria-label'])).toEqual([{ 'role': 'img', 'aria-label': 'Grace' }])

    const initial = await one('/content', '#avatar-initial [aria-hidden]')

    expect([initial.text, initial.attributes.style]).toEqual(['g', expect.stringMatching(/^background-color: #[\dA-F]{6}; color: #(?:000|fff)$/)])
  })

  test('Carousel shows its slide, hides the rest from the focus and screen readers, and names each in the app\'s words', async () => {
    expect(await attributes('/content', '#carousel section', ['aria-roledescription', 'aria-label'])).toEqual([{ 'aria-roledescription': 'carousel', 'aria-label': 'Galerie photos' }])
    expect(await attributes('/content', '#carousel [aria-label$=" sur 2"]', ['aria-label', 'aria-hidden', 'inert'])).toEqual([
      { 'aria-label': '1 sur 2', 'aria-hidden': 'true', 'inert': '' },
      { 'aria-label': '2 sur 2', 'aria-hidden': null, 'inert': null },
    ])
    expect(await attributes('/content', '#carousel .kui-carousel-dot', ['aria-label', 'aria-current'])).toEqual([
      { 'aria-label': 'Aller à l\'image 1', 'aria-current': null },
      { 'aria-label': 'Aller à l\'image 2', 'aria-current': 'true' },
    ])
  })

  test('Carousel draws no controls for a single slide', async () => {
    expect(await attributes('/content', '#lone-slide [aria-label]', ['aria-label'])).toContainEqual({ 'aria-label': 'Slide 1 of 1' })
    expect(await find('/content', '#lone-slide .kui-carousel-controls')).toEqual([])
  })

  test('Badge is neutral unless toned, drawn as a stamp when asked, and EmptyState says why there is nothing', async () => {
    expect(await attributes('/content', '#badge, #stamped .kui-badge', ['data-tone', 'data-stamp'])).toEqual([{ 'data-tone': 'neutral', 'data-stamp': null }, { 'data-tone': 'neutral', 'data-stamp': '' }])
    expect((await find('/content', '#empty p')).map(found => found.text)).toEqual(['No moons', 'Add one to start'])
  })

  test('Badge is filled with its tone when solid, never as a stamp, and its text stays escaped', async () => {
    expect(await attributes('/content', '#solid, #solid-stamp .kui-badge', ['data-tone', 'data-solid'])).toEqual([{ 'data-tone': 'success', 'data-solid': '' }, { 'data-tone': 'neutral', 'data-solid': null }])
    expect((await find('/content', '#solid')).map(found => found.text)).toEqual(['<b>Done</b>'])
  })

  test('EmptyState holds an @actions block below its description, and none without one', async () => {
    expect((await find('/content', '#empty-action .kui-empty-state-actions a')).map(link => [link.attributes.href, link.text])).toEqual([['/paging', 'Build one']])
    expect(await find('/content', '#empty .kui-empty-state-actions')).toEqual([])
  })

  test('Select marks its value\'s option selected, after the empty one', async () => {
    expect((await find('/content', '#form option')).map(option => `${option.attributes.value ?? ''}${option.attributes.selected === undefined ? '' : ' selected'}:${option.text}`)).toEqual([':Any', 'mars:Mars', 'earth selected:Earth'])
  })
})

describe('FormField', () => {
  test('labels its control with what it takes, and shows the message a plain form post was refused with', async () => {
    const field = (await visit('/form'))
    const [hint] = field.find('#field .kui-form-field-hint')
    const [input] = field.find('#field input')

    expect(field.find('#field label').map(label => label.text)).toEqual(['Name*'])
    expect(field.find('#field .kui-form-field-required').map(star => star.attributes['aria-hidden'])).toEqual(['true'])
    // Static on a page of its own, the server links the control to its hint; the message region takes an id once it holds one.
    expect(input!.attributes['aria-describedby']).toBe(hint!.attributes.id)
    // The star is hidden from a screen reader, so the control says it is required itself.
    expect(input!.attributes['aria-required']).toBe('true')
    expect((await attributes('/form', '#compact select', ['aria-required']))).toEqual([{ 'aria-required': null }])

    const { rename } = await import('../src/routes/form.kay')
    const refused = await site.submit(rename, { name: 'A' }, { from: '/form' })

    expect(refused.find('#field .kui-form-field-issue').map(issue => issue.text)).toEqual(['Two letters at least'])

    const [hinted] = refused.find('#field .kui-form-field-hint').map(found => found.attributes.id)
    const [issues] = refused.find('#field .kui-form-field-issues').map(found => found.attributes.id)

    expect(refused.find('#field input').map(control => control.attributes['aria-describedby'])).toEqual([`${hinted} ${issues}`])
  })

  test('sizes itself by its control when compact, holding no message region without a name or an issue', async () => {
    expect(await attributes('/form', '#compact .kui-form-field', ['data-compact'])).toEqual([{ 'data-compact': '' }])
    expect(await find('/form', '#compact .kui-form-field-issues')).toEqual([])
    expect((await find('/form', '#compact label')).map(label => label.text)).toEqual(['Period'])
  })
})

test('TextInput and Textarea without onInput render plain fields whose attributes post with the form', async () => {
  expect(await attributes('/form', '#plain input, #plain textarea', ['name', 'type', 'required', 'autocomplete', 'aria-label', 'rows'])).toEqual([
    { 'name': 'email', 'type': 'email', 'required': '', 'autocomplete': 'email', 'aria-label': 'Email', 'rows': null },
    { 'name': 'bio', 'type': null, 'required': null, 'autocomplete': null, 'aria-label': 'Bio', 'rows': '3' },
  ])
  expect((await one('/form', '#plain textarea')).text).toBe('Hi')
})

describe('layout', () => {
  test('SiteNav marks the page on screen and the section holding it, its links a popover the toggle opens and anchors', async () => {
    expect(await attributes('/layout', '#site-nav nav, #site-nav nav > button, #site-nav ul', ['aria-label', 'aria-expanded', 'popovertarget', 'popover', 'id'])).toEqual([
      { 'aria-label': 'Main', 'aria-expanded': null, 'popovertarget': null, 'popover': null, 'id': null },
      { 'aria-label': 'Ouvrir le menu', 'aria-expanded': null, 'popovertarget': 'main-links', 'popover': null, 'id': null },
      { 'aria-label': null, 'aria-expanded': null, 'popovertarget': null, 'popover': '', 'id': 'main-links' },
    ])
    expect((await find('/layout', '#site-nav a')).map(link => `${link.attributes.href}${link.attributes['aria-current'] ? ` ${link.attributes['aria-current']}` : ''}`)).toEqual(['/', '/chart', '/charts true', '/charts/moons page', '/data'])
  })

  test('PageHeader holds the page h1, its actions past the title only when given, and the children under the title line', async () => {
    expect((await find('/layout', '#header h1, #header .kui-page-header-actions a, #header p')).map(found => [found.tag, found.text])).toEqual([['h1', 'Moons'], ['a', 'New'], ['p', 'Every moon of Mars.']])
    expect((await find('/layout', '#bare-header h1, #bare-header .kui-page-header-actions')).map(found => found.tag)).toEqual(['h1'])
  })

  test('PageSection titles its stretch and holds an actions block at the end of the head line', async () => {
    expect((await find('/layout', '#section h2, #section .kui-page-section-head a, #section > section > p')).map(found => [found.tag, found.text])).toEqual([['h2', 'Moons'], ['a', 'New'], ['p', 'Phobos']])
  })

  test('CollapsibleSection is a native disclosure, folded when asked, boxed, with its meta before the chevron', async () => {
    const [details] = await find('/layout', '#collapsed details')
    const [summary] = await find('/layout', '#collapsed summary')

    expect([attr(details!, 'open'), attr(details!, 'data-boxed')]).toEqual([null, ''])
    expect(summary!.text).toBe('Older2')
    expect(summary!.html.indexOf('kui-badge')).toBeLessThan(summary!.html.indexOf('<svg'))
    expect((await one('/layout', '#collapsed .kui-collapsible-section-body')).text).toBe('Deimos')
  })

  test('Widget heads its body with icon, title and actions, swaps an empty body for its @empty block, and renders nothing empty without one', async () => {
    const head = async (id: string) => (await find('/layout', `#${id} .kui-widget-head > *`)).map(found => found.tag)

    expect(await head('widget')).toEqual(['svg', 'h2', 'a'])
    expect((await one('/layout', '#widget p')).text).toBe('42')
    expect(await head('empty-widget')).toEqual(['h2'])
    expect((await find('/layout', '#empty-widget p')).map(found => found.text)).toEqual(['No visits yet'])
    expect((await one('/layout', '#hidden-widget')).html).toBe('')
  })

  test('CardRow lays its body between what leads and what trails, its actions last', async () => {
    expect((await find('/layout', '#row .kui-card-row > *')).map(found => found.text)).toEqual(['', 'Mars', '3 moons', 'Edit'])
    expect((await one('/layout', '#row .kui-card-row-actions a')).attributes.href).toBe('/form')
  })
})

describe('data', () => {
  test('Stat reads a figure with what it counts', async () => {
    expect((await find('/data', '#stat .kui-stat-badge > span')).map(found => found.text)).toEqual(['12', 'moons'])
  })

  test('Meter is a named meter holding its value between 0 and 100', async () => {
    expect(await attributes('/data', '#meter [role="meter"]', ['aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-label'])).toEqual([{ 'aria-valuenow': '100', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Disk' }])
  })

  test('Progress is a named progressbar, determinate with a value out of max (100 by default) and indeterminate without', async () => {
    expect(await attributes('/data', '#progress [role="progressbar"]', ['aria-valuenow', 'aria-label', 'data-indeterminate'])).toEqual([{ 'aria-valuenow': '43', 'aria-label': 'Export', 'data-indeterminate': null }])
    expect((await one('/data', '#progress .kui-progress-fill')).attributes.style).toBe('width: 42.6%')
    expect(await attributes('/data', '#progress-max [role="progressbar"]', ['aria-valuenow'])).toEqual([{ 'aria-valuenow': '50' }])
    expect((await one('/data', '#progress-max .kui-progress-fill')).attributes.style).toBe('width: 50%')
    expect(await attributes('/data', '#indeterminate [role="progressbar"]', ['aria-valuenow', 'data-indeterminate'])).toEqual([{ 'aria-valuenow': null, 'data-indeterminate': '' }])
  })

  test('Skeleton hides its bars from screen readers, shortens the last, and announces its label as a status', async () => {
    expect((await find('/data', '#skeleton .kui-skeleton-block')).map(found => [attr(found, 'aria-hidden'), attr(found, 'data-last')])).toEqual([['true', null], ['true', null], ['true', '']])
    expect((await find('/data', '#skeleton [role="status"]')).map(found => found.text)).toEqual(['Loading'])
    expect((await one('/data', '#avatar-skeleton .kui-skeleton')).attributes).toMatchObject({ 'data-shape': 'avatar', 'style': '--kui-skeleton-width: 4rem;' })
    expect(await find('/data', '#avatar-skeleton [role="status"]')).toEqual([])
  })

  test('Meter reads value out of a custom max', async () => {
    expect(await attributes('/data', '#meter-max [role="meter"]', ['aria-valuenow', 'aria-valuemax'])).toEqual([{ 'aria-valuenow': '75', 'aria-valuemax': '100' }])
  })

  test('BarList measures each row against the largest, reads its display, and says when it has none', async () => {
    const bars = (await one('/data', '#bars')).html

    expect([...bars.matchAll(/bar-list-value">([^<]*)<.*?width: (\d+)%/g)].map(match => [match[1], match[2]])).toEqual([['2', '100'], ['one', '50'], ['0', '0']])
    expect(await find('/data', '#bars button')).toEqual([])
    expect((await find('/data', '#no-bars-label p')).map(found => found.text)).toEqual(['No visits'])
    expect((await find('/data', '#no-bars-default p')).map(found => found.text)).toEqual(['No data yet.'])
    expect((await find('/fr/data', '#no-bars-default p')).map(found => found.text)).toEqual(['Aucune donnée'])
    expect((await find('/fr/data', '#no-media-default p')).map(found => found.text)).toEqual(['Aucun média'])
    expect((await find('/data', '#no-media p')).map(found => found.text)).toEqual(['No photos'])
  })

  test('SiteFavicon shows the site\'s icon, or the globe in a colour of the site\'s own', async () => {
    expect(await attributes('/data', '#favicon img', ['src', 'alt'])).toEqual([{ src: '/favicon.png', alt: '' }])
    expect((await one('/data', '#no-favicon svg')).attributes.style).toMatch(/^color: #[0-9A-F]{6}$/)
  })

  test('Rating reads its value out of its max, filling that share of the stars, kept between none and all', async () => {
    const rating = async (id: string) => {
      const [meter] = await find('/data', `#${id} [role="img"]`)
      const [fill] = await find('/data', `#${id} .kui-rating-fill`)

      return [meter!.attributes['aria-label'], fill!.attributes.style, (await find('/data', `#${id} [role="img"] > .kui-rating-stars svg`)).length]
    }

    expect(await rating('rating')).toEqual(['4.6 out of 5', 'width: 92%', 5])
    expect(await rating('rating-out')).toEqual(['Top marks', 'width: 100%', 4])
    expect((await rating('rating-below'))[1]).toBe('width: 0%')
    expect((await rating('rating-nan'))[1]).toBe('width: 0%')
    expect(await rating('rating-none')).toEqual(['3 out of 0', 'width: 0%', 0])
  })

  test('CopyButton is a plain button saying what it copies, beside a status saying it copied, taking Button\'s variants', async () => {
    expect((await find('/data', '#copy button, #copy [role="status"], #copy-accent button')).map(found => [found.tag, found.text, attr(found, 'type'), found.attributes.class!.includes('kui-btn-accent')])).toEqual([
      ['button', 'Copy link', 'button', false],
      ['span', '', null, false],
      ['button', 'Copy link', 'button', true],
    ])
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

describe('date and time inputs', () => {
  test('are native fields posting ISO values with no JavaScript, the calendar left to the island', async () => {
    const form = (await element('/inputs', 'dates')).replaceAll(/<!--[^>]*-->/g, '')

    expect(form).toContain('name="day" data-part="input" min="2026-10-01" type="date" value="2026-10-21"')
    expect(form).toContain('name="from" aria-label="Stay from" data-part="input" type="date" value="2026-10-02"')
    expect(form).toContain('name="to" aria-label="Stay to" data-part="input" type="date"')
    expect(form).toContain('name="start" data-part="root" type="time" value="09:30"')
    expect(form).not.toContain('popover')
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
  test('pairs each tab with its panel through drawn ids, and shows the starting tab\'s panel alone, the others hidden until found and out of the tab order', async () => {
    const tabs = await element('/tabs', 'planets')
    const pairs = [...tabs.matchAll(/role="tab" id="([^"]+)" aria-controls="([^"]+)" aria-selected="(\w+)" tabindex="(-?\d)"/g)].map(match => match.slice(1))
    const panels = [...tabs.matchAll(/role="tabpanel" id="([^"]+)" aria-labelledby="([^"]+)"(?: tabindex="0"| (hidden="until-found"))/g)].map(match => match.slice(1))

    expect(pairs.map(([, , selected, index]) => [selected, index])).toEqual([['false', '-1'], ['true', '0'], ['false', '-1']])
    expect(panels.map(([panel, tab, hidden]) => [panel, tab, Boolean(hidden)])).toEqual(pairs.map(([tab, panel], index) => [panel, tab, index !== 1]))
    expect(new Set(pairs.flatMap(([tab, panel]) => [tab, panel])).size).toBe(6)
  })
})

describe('charts', () => {
  const page = async (id: string) => (await one('/charts', `#${id}`)).html.replaceAll(/<!--[^>]*-->/g, '').replaceAll(/<\/?slot[^>]*>/g, '')

  test('LineChart renders its frame, a table of its values for screen readers, a keyboard slider on the latest point and a legend dashing each line on the server, leaving the drawing to the browser', async () => {
    expect(await attributes('/charts', '#line [role="figure"], #line [aria-hidden="true"], #line [role="slider"]', ['aria-label', 'aria-valuenow', 'aria-valuemax', 'aria-valuetext', 'tabindex'])).toEqual([
      { 'aria-label': 'Visits', 'aria-valuenow': null, 'aria-valuemax': null, 'aria-valuetext': null, 'tabindex': null },
      { 'aria-label': null, 'aria-valuenow': null, 'aria-valuemax': null, 'aria-valuetext': null, 'tabindex': null },
      { 'aria-label': 'Visits', 'aria-valuenow': '2', 'aria-valuemax': '2', 'aria-valuetext': '8 Sept 2026: Visits 5, Sales 1', 'tabindex': '0' },
    ])
    expect((await one('/charts', '#line [aria-hidden="true"]')).html).toBe('')
    expect((await find('/charts', '#line caption, #line thead th, #line tbody th, #line tbody td')).map(found => found.text)).toEqual(['Visits', 'Visits', 'Sales', '2026-09-01', '3', '1', '2026-09-02', '-', '2', '2026-09-08', '5', '1'])

    const keys = await find('/charts', '#line .kui-line-chart-legend-item')

    expect(keys.map(item => item.text)).toEqual(['Visits', 'Sales'])
    // The second line is dashed so the two stay apart without their colours.
    expect(keys.map(item => item.html.includes('repeating-linear-gradient'))).toEqual([false, true])
  })

  test('ScatterChart places dots, ticks, guides and corners along its axes, a dot\'s size following its weight', async () => {
    const scatter = await page('scatter')

    expect([...scatter.matchAll(/aria-label="(\w+)" data-tooltip="([^"]+)" style="([^"]+)"/g)].map(match => match.slice(1))).toEqual([
      ['Hades', 'Hades', 'left: 25%; bottom: 100%; --kui-dot-size: 1.75rem'],
      ['Celeste', 'Celeste, 30h', 'left: 75%; bottom: 0%; --kui-dot-size: 1.1875rem'],
    ])
    expect(scatter).toContain('<span class="kui-scatter-chart-grid" data-axis="x" style="left: 50%"><span class="kui-scatter-chart-tick">20h</span></span><span class="kui-scatter-chart-guide" data-axis="y" style="bottom: 50%"></span><span class="kui-scatter-chart-guide" data-axis="x" style="left: 50%"></span><span class="kui-scatter-chart-corner" data-corner="topRight">Long and loved</span>')
    expect(scatter).not.toContain('<button')
    expect(await page('no-scatter-label')).toBe('<p class="kui-scatter-chart-empty">No titles</p>')
  })

  test('ContributionGraph shades each day by how full it was, says so in its name, marks today, and names the months over their weeks', async () => {
    const graph = await page('graph')
    const cells = [...graph.matchAll(/<span class="kui-contribution-cell" role="img" aria-label="([^"]+)"[^>]*?( data-today)? style="([^"]+)"/g)].map(match => [match[1], Boolean(match[2]), match[3]])

    expect(cells.slice(0, 3)).toEqual([
      ['3 commits · 2026-08-31', false, 'grid-row: 2; grid-column: 1'],
      ['50% · 2026-09-01', false, 'background-color: color-mix(in srgb, var(--color-kui-accent) 63%, transparent); grid-row: 3; grid-column: 1'],
      ['100% · 2026-09-02', true, 'background-color: color-mix(in srgb, var(--color-kui-accent) 100%, transparent); grid-row: 4; grid-column: 1'],
    ])
    expect(cells.at(-1)?.[2]).toContain('grid-row: 8; grid-column: 3')
    expect(graph).toMatch(/^<div role="group" aria-label="Contributions" class="kui-contribution-graph kui-contribution-graph-months"><span class="kui-contribution-month" aria-hidden="true" style="grid-column: 1">Sep\w*<\/span><span class="kui-contribution-cell"/)
  })
})

describe('Pagination', () => {
  // Each step and page of a strip, in order: its text, where it links, whether it is the current page and its rel.
  const strip = async (path: string, id: string) => (await find(path, `#${id} nav > *`)).map(found => [found.text, attr(found, 'href'), attr(found, 'aria-current'), attr(found, 'rel')])

  test('links each page through the query, the current one marked, the steps past the ends disabled', async () => {
    expect((await attributes('/paging', '#first nav', ['aria-label']))).toEqual([{ 'aria-label': 'Pagination' }])
    expect(await strip('/paging', 'first')).toEqual([
      ['Previous', null, null, null],
      ['1', '/posts?tag=kay', 'page', null],
      ['2', '/posts?tag=kay&page=2', null, null],
      ['3', '/posts?tag=kay&page=3', null, null],
      ['Next', '/posts?tag=kay&page=2', null, 'next'],
    ])
  })

  test('follows the page the URL asks for, with gaps around it, in the page\'s language, and draws nothing for a single page', async () => {
    const middle = await strip('/paging?page=10', 'middle')

    expect(middle.map(([text]) => text)).toEqual(['Précédent', '1', '…', '9', '10', '11', '…', '20', 'Suivant'])
    expect(middle.find(([text]) => text === 'Précédent')).toEqual(['Précédent', '/paging?page=9', null, 'prev'])
    expect(middle.find(([text]) => text === '10')).toEqual(['10', '/paging?page=10', 'page', null])
    expect(await find('/paging', '#single nav')).toEqual([])
  })

  test('takes a page kay\'s paginate() gave, linking each page at the path it names', async () => {
    expect(await strip('/paging', 'paged')).toEqual([
      ['Previous', '/blog', null, 'prev'],
      ['1', '/blog', null, null],
      ['2', '/blog/2', 'page', null],
      ['3', '/blog/3', null, null],
      ['Next', '/blog/3', null, 'next'],
    ])
  })

  test('links only the steps either side of a list whose length is unknown, by page or by offset, and draws nothing for its one page', async () => {
    expect(await strip('/paging', 'open')).toEqual([['Previous', '/gallery?tag=kay', null, 'prev'], ['Next', '/gallery?tag=kay&page=3', null, 'next']])
    expect(await strip('/paging', 'offset')).toEqual([['Previous', '/gallery?offset=20&tag=kay', null, 'prev'], ['Next', null, null, null]])
    expect(await find('/paging', '#open-single nav')).toEqual([])
  })

  test('shows a page past the ends, or none at all, as the nearest that exists', async () => {
    const current = async (path: string) => (await strip(path, 'middle')).find(([, , page]) => page === 'page')

    expect(await current('/paging?page=50')).toEqual(['20', '/paging?page=20', 'page', null])
    expect((await strip('/paging?page=50', 'middle')).at(-1)).toEqual(['Suivant', null, null, null])
    expect(await current('/paging?page=abc')).toEqual(['1', '/paging', 'page', null])
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

describe('FormDialog', () => {
  test('takes a page\'s action as a prop, which goes to the island as its URL', async () => {
    const { rename } = await import('../src/routes/dialog-action.kay') as { rename: { url: string } }
    const { html, status } = await site.visit('/dialog-action')

    expect(status).toBe(200)
    expect(html).toContain(`"${rename.url}"`)
    expect(html).toContain('data-props=')
  })
})

describe('ContactForm', () => {
  test('posts to the action with its fields, the honeypot and the extra field between the email and the message', async () => {
    const { html } = await site.visit('/contact')

    expect(html.indexOf('name="name"')).toBeLessThan(html.indexOf('name="email"'))
    expect(html.indexOf('name="email"')).toBeLessThan(html.indexOf('name="topic"'))
    expect(html.indexOf('name="topic"')).toBeLessThan(html.indexOf('name="message"'))
    expect(html).toContain('name="website"')
    expect(html).toContain('Send it')
    expect(html).not.toContain('Thank you')
  })

  test('words its labels and the refused fields in the page\'s language with no props', async () => {
    const { contact } = await import('../src/routes/contact-words.kay')

    expect((await site.visit('/contact-words')).html).toContain('>Send<')
    expect((await site.visit('/contact-words')).html).toContain('Name')

    const french = (await site.visit('/fr/contact-words')).html

    // `ui.contactForm.submitLabel` wins over kayjs-mail's `mail.contact.form.submit`, which still words the other labels.
    expect(french).toContain('Expédier')
    expect(french).not.toContain('Envoyer')
    expect(french).toContain('Nom')
    expect(french).not.toContain('>Send<')

    const refused = await site.submit(contact, { name: 'Ada', email: 'nope', message: 'Bonjour' }, { from: '/fr/contact-words' })

    expect(refused.html).toContain('<span class="kui-form-field-issue">Merci d\'écrire une adresse e-mail valide.</span>')
  })

  test('draws the consent checkbox of an action asking for one, with the privacy link and the renamed honeypot, and no box without', async () => {
    const { contact } = await import('../src/routes/contact-consent.kay')
    const { html } = await site.visit('/contact-consent')

    expect(html).toContain('name="consent"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('I agree that my details are used to answer my message.')
    expect(html).toContain('<a href="/privacy" target="_blank" rel="noopener">Privacy policy</a>')
    expect(html).toContain('name="nectar"')
    expect((await site.visit('/fr/contact-consent')).html).toContain('Politique de confidentialité')
    expect((await site.visit('/contact-words')).html).not.toContain('name="consent"')

    const refused = await site.submit(contact, { name: 'Ada', email: 'ada@example.com', message: 'Hi', consent: false } as never, { from: '/contact-consent' })

    expect(refused.html).toContain('class="kui-form-field-issue">Please tick the box to send your message.</span>')
  })

  test('draws no consent box for an app\'s own consent field, which only consent: true marks', async () => {
    await import('../src/routes/contact-own-consent.kay')

    const { html } = await site.visit('/contact-own-consent')

    expect(html).not.toContain('I agree that my details')
    expect(html).not.toContain('name="consent"')
  })

  test('shows each refused field\'s message under it and the thanks once a post goes through', async () => {
    const { contact } = await import('../src/routes/contact.kay')
    const refused = await site.submit(contact, { name: 'A', email: 'nope', topic: 'quote', message: 'Hi' }, { from: '/contact' })

    expect(refused.html).toContain('<span class="kui-form-field-issue">Tell us your name</span>')
    expect(refused.html).toContain('<span class="kui-form-field-issue">Not an email address</span>')
    expect(refused.html).toContain('<span class="kui-form-field-issue">A few words at least</span>')

    const sent = await site.submit(contact, { name: 'Ada', email: 'ada@example.com', topic: 'quote', message: 'Hello there' }, { from: '/contact' })

    expect(sent.html).toContain('Thank you, your message has been sent.')

    const failed = await site.submit(contact, { name: 'Ada', email: 'ada@example.com', topic: 'quote', message: 'Please fail' }, { from: '/contact' })

    expect(failed.html).toContain('Could not send it')
    expect(failed.html).not.toContain('Thank you')
  })
})

// A script a page loads.
const SCRIPT_PATH = /src="(\/[^"]+\.js)"/g
// A script a module imports, statically or through `import()`.
const STATIC_IMPORT = /(?:from|import)\s*["'](\.\/[^"']+\.js)["']/g
const DYNAMIC_IMPORT = /import\(\s*["'](\.\/[^"']+\.js)["']/g
const TURNDOWN = /turndown/i
const CHUNK_NAME = /data-chunk="([^"/]+\.js)"/g

test('a CopyButton island ships no HTML to Markdown converter, and MarkdownEditor loads it only on demand', async () => {
  // Built for the browser, never opened in one.
  const built = await testSite({ root: ROOT, browser: true })
  const scripts = new Map<string, string>()
  const script = async (path: string) => {
    if (!scripts.has(path))
      scripts.set(path, await (await built.fetch(path)).text())

    return scripts.get(path)!
  }
  const imports = (code: string, kind: RegExp) => [...code.matchAll(kind)].map(([, file = '']) => `/_kay/${file.slice(2)}`)
  // Every script that loads with `path`, itself included.
  const loadedWith = async (path: string, seen = new Set<string>()): Promise<Set<string>> => {
    if (!seen.has(path)) {
      seen.add(path)
      for (const next of imports(await script(path), STATIC_IMPORT))
        await loadedWith(next, seen)
    }

    return seen
  }
  const converting = async (paths: Set<string>) => (await Promise.all([...paths].map(async path => TURNDOWN.test(await script(path)) ? [path] : []))).flat()

  try {
    // Each island's markup names its chunk, and every chunk a page can load is reached from those and the entry.
    const reached = new Set<string>()
    const reach = async (path: string) => {
      if (reached.has(path))
        return

      reached.add(path)
      const code = await script(path)

      for (const next of [...imports(code, STATIC_IMPORT), ...imports(code, DYNAMIC_IMPORT)])
        await reach(next)
    }

    for (const page of ['/data', '/form-reset']) {
      const { html } = await built.visit(page)
      const paths = [...[...html.matchAll(SCRIPT_PATH)].map(([, path = '']) => path), ...[...html.matchAll(CHUNK_NAME)].map(([, file = '']) => `/_kay/${file}`)]

      for (const path of paths)
        await reach(path)
    }

    const island = (name: string) => [...reached].find(path => path.startsWith(`/_kay/${name}-`))!

    expect(island('copy-button')).toBeDefined()
    // The form-reset island renders a MarkdownEditor, which its chunk carries.
    expect(island('form-reset')).toBeDefined()
    const copyButton = await loadedWith(island('copy-button'))
    const editor = await loadedWith(island('form-reset'))
    const onPaste = new Set<string>()

    for (const path of editor) {
      for (const next of imports(await script(path), DYNAMIC_IMPORT))
        await loadedWith(next, onPaste)
    }

    expect(await converting(copyButton)).toEqual([])
    expect(await converting(editor)).toEqual([])
    expect((await converting(onPaste)).length).toBeGreaterThan(0)
  }
  finally {
    await built.close()
  }
})

describe('the texts a component shows by default, in the app\'s catalogs', () => {
  test('read `ui.*` messages in the page\'s locale, keep a prop given over them, and leave the English where a key is missing', async () => {
    const french = (await visit('/fr/paging')).html
    const english = (await visit('/paging')).html
    const first = french.slice(french.indexOf('id="first"'), french.indexOf('id="middle"'))

    expect(first).toContain('aria-label="Pages"')
    expect(first).toContain('Suivant')
    expect(english).toContain('aria-label="Pagination"')
    expect(english.slice(english.indexOf('id="first"'), english.indexOf('id="middle"'))).toContain('Next')
    // `#middle` gives its own label and arrow texts, which win over the catalog.
    expect(french).toContain('aria-label="Posts"')
  })

  test('read the French kayjs-ui ships on a French page with no message of the app, the app\'s own key and a prop winning over it', async () => {
    const french = (await visit('/fr/confirm-words')).html
    const plain = french.slice(french.indexOf('id="plain"'), french.indexOf('id="given"'))
    const english = (await visit('/confirm-words')).html

    expect(plain).toContain('aria-label="Supprimer"')
    // The fixture words the title itself, and a French page writes a non-breaking space before its question mark.
    expect(plain).toContain('aria-label="Supprimer cet élément\u00A0?"')
    expect(english).toContain('aria-label="Delete"')
    expect(english).not.toContain('Supprimer')
  })

  test('send the browser the messages an island only reads after the page loaded', async () => {
    // The islands are built, so the page sends the messages its islands name in their source.
    const built = await testSite({ root: ROOT, browser: true })

    try {
      const payload = (/<script type="application\/json" data-kay-i18n>(.*?)<\/script>/).exec((await built.visit('/fr/table')).html)?.[1]

      expect(Object.keys((JSON.parse(payload!) as { messages: object }).messages)).toEqual(expect.arrayContaining(['ui.table.rowCount', 'ui.table.filterLabel']))
    }
    finally {
      await built.close()
    }
  })

  test('follow the page\'s locale for the months a chart names and the count a table gives, a plural message included', async () => {
    const graph = (await visit('/fr/charts')).html
    const filtered = (await visit('/fr/table?q=a')).html

    expect(graph).toMatch(/class="kui-contribution-month"[^>]*>sept\./)
    expect((await visit('/charts')).html).toMatch(/class="kui-contribution-month"[^>]*>Sep/)
    expect(filtered).toContain('Filtrer')
    expect(filtered).toMatch(/class="kui-table-count" data-part="count" role="status">\d+ lignes?</)
  })
})

describe('variant names the form and tone the meaning', () => {
  const shown = async (id: string) => {
    const found = await one('/buttons', `#${id}`)

    return [attr(found, 'class'), attr(found, 'data-variant'), attr(found, 'data-size'), attr(found, 'data-tone')]
  }

  test('Button draws a variant and a size, accent and danger being tones', async () => {
    expect(await shown('tone-accent')).toEqual(['kui-btn kui-btn-accent', 'solid', 'lg', null])
    expect(await shown('ghost-danger')).toEqual(['kui-btn kui-btn-danger', 'ghost', 'xs', null])
    expect(await shown('inline-plain')).toEqual(['kui-btn', 'inline', 'md', null])
    expect(await shown('plain')).toEqual(['kui-btn', 'solid', 'md', null])
  })

  test('CopyButton takes the same variant, tone and size', async () => {
    expect(await shown('copy-new')).toEqual([expect.stringContaining('kui-btn-danger'), 'ghost', 'sm', null])
  })

  test('IconButton reads a tone', async () => {
    expect(await shown('icon-tone')).toEqual([expect.not.stringContaining('kui-shell'), 'ghost', 'md', 'danger'])
    expect(await shown('icon-accent')).toEqual([expect.stringContaining('kui-shell'), 'solid', 'md', 'accent'])
    expect(await shown('delete')).toEqual([expect.stringContaining('kui-shell-danger'), 'solid', 'sm', 'danger'])
  })

  test('Notice has a danger tone, an alert', async () => {
    const roles = async (id: string) => {
      const found = await one('/buttons', `#${id}`)

      return [attr(found, 'data-tone'), attr(found, 'role')]
    }

    expect(await roles('notice-danger')).toEqual(['danger', 'alert'])
    expect(await roles('notice-default')).toEqual(['info', 'status'])
  })
})

test('a page swap with a toast on screen hydrates the next toaster without a mismatch', async () => {
  const built = await testSite({ root: ROOT, browser: true })

  try {
    await using page = await built.open('/toast-a')

    await page.waitUntil(() => document.querySelector('.kui-toaster') !== null)
    await page.click('#saved')
    await page.waitUntil(() => document.querySelector('.kui-toast') !== null)
    await page.click('#next')
    await page.waitUntil(() => document.querySelector('h1')?.textContent === 'Toast b')
    await page.waitUntil(() => document.querySelector('.kui-toast-message')?.textContent === 'Saved')
    expect(page.errors).toEqual([])
  }
  finally {
    await built.close()
  }
}, 60_000)

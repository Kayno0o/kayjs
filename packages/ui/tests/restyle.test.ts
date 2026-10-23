import { existsSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { kay } from '../../../src/build/plugin'
import { uiProblems } from '../../../src/check/ui'
import { REMOVED_UI_CLASSES } from '../../../src/check/ui-classes'
import { child } from '../../../src/runtime/html'

// An app of its own, as `src/ui.ts` restyles every instance of a component in the app: the library's fixture app renders the same components untouched, and its contract tests compare them. Built apart from testSite, which serves one project per test process.
const ROOT = join(import.meta.dir, 'restyle-app')
const LIBRARY = join(import.meta.dir, '..')
const LINK = join(ROOT, 'node_modules', '@kaynooo', 'kayjs-ui')
const OUT = join(ROOT, 'node_modules', '.cache', 'out')
const MARKERS = /<!--[[\]]-->/g
const REMOVED_CLASS = new RegExp(Object.keys(REMOVED_UI_CLASSES).map(name => `\\b${name}\\b`).join('|'))

let html = ''
let browser = ''

beforeAll(async () => {
  if (!existsSync(LINK)) {
    await mkdir(dirname(LINK), { recursive: true })
    await symlink(relative(dirname(LINK), LIBRARY), LINK)
  }

  const build = await Bun.build({ entrypoints: [join(ROOT, 'src/entry.ts')], outdir: OUT, target: 'bun', plugins: [kay({ root: ROOT, target: 'ssr' })] })

  if (!build.success)
    throw new AggregateError(build.logs, 'build failed')

  const { Page } = await import(build.outputs[0]!.path) as { Page: (props: Record<string, unknown>) => unknown }

  html = child(Page({})).replace(MARKERS, '')

  const dom = await Bun.build({ entrypoints: [join(ROOT, 'src/entry.ts')], outdir: join(OUT, 'dom'), target: 'browser', plugins: [kay({ root: ROOT, target: 'dom' })] })

  if (!dom.success)
    throw new AggregateError(dom.logs, 'browser build failed')

  browser = await dom.outputs[0]!.text()
}, 60_000)

afterAll(async () => rm(OUT, { recursive: true, force: true }))

// The classes of the first tag holding the text.
const classesOfTag = (text: string, tag = '[a-z0-9]+') => (html.match(new RegExp(`<${tag}[^>]*${text}[^>]*>`))?.[0].match(/ class="([^"]*)"/)?.[1] ?? '').split(' ')

describe('restyling a component of kayjs-ui from src/ui.ts', () => {
  // Each part keeps the kui class theme.css styles, then takes what the app's src/ui.ts sets on it, and the caller's class object comes last.
  const restyled = [
    'kui-dialog-title text-xl',
    'kui-dialog-footer justify-end',
    'kui-table-wrap gap-3',
    'kui-table text-sm',
    'kui-icon kui-table-sort-icon size-4',
    'kui-field-input kui-table-filter-input w-64',
    'kui-table-count text-xs',
    'kui-table-selection mb-2',
    'kui-table-head-cell uppercase',
    'kui-table-cell py-4',
    'kui-date-input gap-2',
    'kui-date-range-input-separator mx-1',
    'kui-field-input kui-multi-select-trigger min-w-40',
    'kui-multi-select-option py-2',
    'kui-multi-select-action underline',
    'kui-field-input kui-range-input-box w-24',
    'kui-range-input-unit ml-1',
    'kui-segmented-option px-5',
    'kui-icon kui-segmented-icon size-3',
    'kui-rating-stars text-amber-500',
    'kui-file-drop border-dashed',
    'kui-btn kui-copy-btn kui-btn-accent ring-2',
    'kui-copy-btn-text font-mono',
    'kui-menu-item py-3',
    'kui-menu-list min-w-48',
    'kui-color-input-label font-medium',
    'kui-color-input-value tabular-nums',
    'kui-slider-label font-medium',
    'kui-slider-value tabular-nums',
    'kui-bar-list-row py-1',
    'kui-bar-list-label font-medium',
    'kui-bar-list-track h-2',
    'kui-chip rounded-full',
    'kui-collapsible-section-summary py-3',
    'kui-collapsible-section-body pt-2',
    'kui-popover shadow-xl',
    'kui-side-panel-head px-6',
    'kui-side-panel-title text-lg',
    'kui-side-panel-body px-6',
    'kui-save-bar sticky',
    'kui-save-bar-status italic',
    'kui-save-bar-actions gap-4',
    'kui-command-palette rounded-2xl',
    'kui-tabs-tab px-5',
    'kui-tabs-panel pt-4',
    'kui-tab-nav-link font-semibold',
    'kui-site-nav-link rounded-md',
    'kui-site-nav-list gap-3',
    'kui-site-nav kui-app-header-nav',
    'kui-app-header-brand text-lg',
    'kui-app-header-end ml-auto',
    'kui-pagination-step px-4',
    'kui-pagination-page min-w-10',
    'kui-split-layout-sidebar-head h-14',
    'kui-split-layout-list overflow-auto',
    'kui-split-layout-detail p-6',
    'kui-split-layout-resizer w-2',
    'kui-tree-view-item py-1',
    'kui-tree-view-label truncate',
    'kui-virtual-list h-96',
    'kui-line-chart-plot h-72',
    'kui-line-chart-legend gap-6',
    'kui-line-chart-legend-item text-sm',
    'kui-scatter-chart-plot aspect-video',
    'kui-contribution-cell rounded-full',
    'kui-contribution-month font-medium',
    'kui-carousel-viewport rounded-3xl',
    'kui-carousel-dot size-4',
    'kui-masonry p-3',
    'kui-media-gallery-stage rounded-3xl',
    'kui-media-gallery-thumb opacity-80',
    'kui-media-gallery-counter font-mono',
    'kui-image-cropper-stage bg-black',
    'kui-zoom-pane h-96',
    'kui-zoom-tools gap-2',
    'kui-qr-code rounded-lg',
    'kui-site-favicon size-6',
    'kui-icon-grid gap-3',
    'kui-icon-grid-bar pt-2',
    'kui-markdown-grid gap-6',
    'kui-markdown-bar px-4',
    'kui-bar-chart-plot h-64',
    'kui-bar-chart-column px-px',
    'kui-bar-chart-bar rounded-t-md',
    'kui-bar-chart-axis-label font-mono',
    'kui-bar-chart-legend-item gap-2',
    'kui-accordion gap-5',
    'kui-breadcrumb-list gap-4',
    'kui-breadcrumb-link underline',
    'kui-breadcrumb-text font-bold',
    'kui-radio-group gap-5',
    'kui-radio-choice p-2',
    'kui-radio-label font-medium',
    'kui-radio-description text-xs',
    'kui-toaster z-50',
    'kui-toaster-live gap-2',
    'kui-tooltip text-xs',
    'kui-form-dialog-footer pt-4',
    'kui-form-dialog-actions gap-3',
    'kui-form-grid gap-5',
    'kui-contact-form gap-7',
    'kui-when-visible min-h-4',
    'kui-icon kui-collapsible-section-chevron size-6',
    'kui-icon kui-tabs-icon size-3',
    'kui-icon kui-site-nav-toggle-menu size-6',
    'kui-icon kui-tree-view-icon size-3',
    'kui-icon kui-chip-icon size-3',
    'kui-pagination-gap opacity-50',
    'kui-site-favicon-img rounded-sm',
    'kui-load-more py-6',
    'kui-combobox gap-2',
    'kui-field-input h-11',
    'kui-combobox-option py-2',
    'kui-combobox-status text-xs',
    'kui-steps-list gap-4',
    'kui-steps-marker size-8',
    'kui-steps-state sr-only',
  ]

  test.each(restyled)('draws class="%s"', (classes) => {
    expect(html).toContain(`class="${classes}"`)
  })

  test('a button with an onClick takes the restyle of Button once, not twice', () => {
    const classes = classesOfTag('id="busy"')

    expect(classes.filter(name => name === 'kui-btn')).toHaveLength(1)
    expect(classes.filter(name => name === 'tracking-wide')).toHaveLength(1)
    expect(classes.at(-1)).toBe('tracking-wide')
  })

  test('a busy button, a busy link and a busy button with an onClick draw the spinner part restyled', () => {
    expect(html.match(/class="kui-icon animate-spin motion-reduce:animate-none size-5"/g)).toHaveLength(3)
    expect(html.match(/class="kui-icon animate-spin motion-reduce:animate-none"/g)).toBeNull()
  })

  test('an IconButton and the trigger of a Menu take the restyle, a Menu class string going to the trigger', () => {
    expect(classesOfTag('id="icon-button"')).toEqual(expect.arrayContaining(['kui-shell', 'kui-icon-btn', 'size-7']))
    expect(classesOfTag('id="icon-button"').at(-1)).toBe('rounded-full')
    expect(classesOfTag('aria-haspopup="menu"').slice(-2)).toEqual(['rounded-full', 'menu-trigger'])
  })

  test('a class string on a button with an onClick joins the restyle', () => {
    expect(classesOfTag('id="single"').filter(name => name === 'kui-btn')).toHaveLength(1)
    expect(classesOfTag('id="single"').at(-1)).toBe('rounded-none')
  })

  test('the browser build of an island puts the restyled classes after the kui class of their part', () => {
    for (const [part, classes] of [['title', 'text-xl'], ['footer', 'justify-end'], ['headCell', 'uppercase'], ['cell', 'py-4'], ['panel', 'w-72']] as const)
      expect(browser).toMatch(new RegExp(`look\\d+\\(__props, "${part}"\\), "${classes}"`))

    expect(browser).toContain('class: "rounded-none" }')
    expect(browser).toContain('inline: { root: "tracking-wide" }')
    expect(browser).toMatch(/class: \[rest\.class, look\d+\(__props, "root"\), "h-12"/)
  })

  test('the browser build draws the parts of a reactive recipe with the restyle: Tabs, Toggle, MultiSelect, IconPicker and DateInput', () => {
    for (const [part, classes] of [['tab', 'px-5'], ['track', 'w-12'], ['option', 'py-2'], ['option', 'rounded-xl'], ['day', 'h-9']] as const)
      expect(browser).toMatch(new RegExp(`look\\d+\\(__props, "${part}"\\), "${classes}"`))
  })

  test('an empty BarList and an empty MediaGallery take the classes of their root part', () => {
    expect(html).toMatch(/<p class="kui-bar-list-empty kui-bar-list text-gray-500" data-part="root" id="bars-empty">/)
    expect(html).toMatch(/<p class="kui-media-gallery-empty kui-media-gallery text-center"[^>]*id="gallery-empty"/)
  })

  test('a component used as a part of another keeps the part name its caller hands it', () => {
    expect(html).toMatch(/<svg[^>]*data-part="spinner"/)
    expect(classesOfTag('data-part="step"', 'button').filter(name => name === 'kui-icon-btn')).toHaveLength(1)
    expect(classesOfTag('data-part="step"', 'button').slice(-3)).toEqual(['rounded-full', 'kui-carousel-step', 'size-12'])
    expect(html).toMatch(/<svg[^>]*data-part="sortIcon"/)
  })

  test('kay check reports a part a component of kayjs-ui does not have, and takes a variant or value it lacks', async () => {
    const project = join(ROOT, 'node_modules', '.cache', 'bad-ui')

    await mkdir(join(project, 'src'), { recursive: true })
    await writeFile(join(project, 'src/ui.ts'), 'export default { \'@kaynooo/kayjs-ui/card.kay\': { parts: { foot: \'a\' }, variants: { size: { sm: \'b\' } } }, \'@kaynooo/kayjs-ui/button.kay\': { variants: { tone: { loud: { root: \'c\' } } } } }')

    expect(uiProblems(project).map(problem => problem.message)).toEqual([
      '`@kaynooo/kayjs-ui/card.kay` has no part `foot`',
    ])
    expect(uiProblems(ROOT)).toEqual([])
  })

  test('a part nothing restyles keeps its kui class alone', () => {
    expect(html).toContain('class="kui-dialog-body"')
    expect(html).toContain('class="kui-table-row"')
  })
})

describe('the buttons and fields whose recipe holds their look', () => {
  // The classes of the element an id or a data-part under it selects, in the order they are written.
  // A FormField takes no id, so its parts are the first after the TimeInput written before it.
  const classesOfPart = (id: string, part?: string) => {
    const root = id === 'field' ? html.indexOf('id="time"') : html.indexOf(`id="${id}"`)
    const start = part === undefined ? root : html.indexOf(`data-part="${part}"`, root)
    const tag = html.slice(html.lastIndexOf('<', start), html.indexOf('>', start))

    return (tag.match(/ class="([^"]*)"/)?.[1] ?? '').split(' ')
  }

  test.each([
    ['plain', undefined, 'inline-flex', 'bg-red-600'],
    ['busy', undefined, 'gap-kui-inline', 'tracking-wide'],
    ['text', undefined, 'px-kui-field-x', 'h-12'],
    ['area', undefined, 'px-kui-field-x', 'min-h-32'],
    ['select', undefined, 'pl-kui-field-x', 'pr-8'],
    ['field', 'hint', 'text-kui-subtext0', 'text-xs'],
    ['field', 'label', 'contents', 'gap-1'],
    ['field', 'head', 'order-first', undefined],
    ['checkbox', 'input', 'accent-kui-accent', 'size-5'],
    ['checkbox', 'hint', 'text-kui-subtext0', 'opacity-70'],
    ['toggle', 'track', 'bg-kui-surface0', 'w-12'],
    ['icon-button', undefined, 'size-7', 'rounded-full'],
  ] as const)('%s %s draws its base, then what src/ui.ts sets after it', (id, part, base, restyle) => {
    const classes = classesOfPart(id, part)

    expect(classes).toContain(base)

    if (restyle !== undefined)
      expect(classes.at(-1)).toBe(restyle)
  })

  test('only a root keeps a kui class, and the label type FormField shares with Table', () => {
    for (const [id, part] of [['field', 'hint'], ['field', 'label'], ['field', 'head'], ['field', 'required'], ['checkbox', 'input'], ['checkbox', 'hint'], ['toggle', 'input'], ['toggle', 'track']] as const)
      expect(classesOfPart(id, part).filter(name => name.startsWith('kui-')), `${id} ${part}`).toEqual([])

    expect(classesOfPart('field', 'text')[0]).toBe('kui-label-text')
  })

  test('a text field, a textarea and a select keep kui-field-input as the name of their rule', () => {
    for (const id of ['text', 'area', 'select'])
      expect(classesOfPart(id)[0], id).toBe('kui-field-input')
  })
})

describe('a component whose recipe holds its look', () => {
  const classesOf = (tag: string) => (html.match(new RegExp(`<[a-z0-9]+[^>]*${tag}[^>]*>`))?.[0].match(/ class="([^"]*)"/)?.[1] ?? '').split(' ')

  test('keeps the kui class of its root as a name, writes the base as utilities and puts src/ui.ts after them', () => {
    const card = classesOf('id="card"')

    expect(card[0]).toBe('kui-card')
    expect(card).toContain('rounded-kui-card')
    expect(card.at(-1)).toBe('rounded-xl')
    expect(card.indexOf('rounded-kui-card')).toBeLessThan(card.indexOf('rounded-xl'))
    expect(classesOf('id="badge"')).toEqual(expect.arrayContaining(['kui-badge', '[--kui-badge-color:var(--color-kui-success)]', 'bg-green-100']))
    expect(classesOf('id="notice"')).toEqual(expect.arrayContaining(['kui-notice', '[--kui-notice-tone:var(--color-kui-error)]', 'border-2']))
  })

  test('sets no kui class on its other parts, which carry data-part to select them by', () => {
    expect(html).toMatch(/<div class="[^"]*\bp-6" data-part="head">/)
    expect(html).toMatch(/<h3 class="[^"]*\bitalic" data-part="title">/)
    expect(html).toMatch(/<div class="p-kui-card p-9" data-part="body">/)
    expect(html).not.toMatch(/kui-card-(?:head|title|body)|kui-badge-icon/)
  })
})

describe('a SidePanel with modal={false}', () => {
  test('renders open on the server with a close link, and a modal one has neither', () => {
    expect(html.match(/<dialog[^>]*id="beside"[^>]*>/)![0]).toMatch(/ open(?=[ >])/)
    expect(html.match(/<dialog[^>]*id="beside"[^>]*>/)![0]).toContain('closedby="closerequest"')
    expect(html).toMatch(/<a [^>]*href="\/list"[^>]*aria-label="Close"/)
    expect(html.match(/<dialog[^>]*id="side"[^>]*>/)![0]).not.toMatch(/ open[ >=]/)
  })
})

describe('the display components whose recipe holds their look', () => {
  // The classes of the element an id or a data-part selects, in the order they are written.
  const classesOfPart = (id: string, part?: string) => {
    const root = html.indexOf(`id="${id}"`)
    const start = part === undefined ? root : html.indexOf(`data-part="${part}"`, root)
    const tag = html.slice(html.lastIndexOf('<', start), html.indexOf('>', start))

    return (tag.match(/ class="([^"]*)"/)?.[1] ?? '').split(' ')
  }

  test.each([
    ['avatar', undefined, 'rounded-kui-full', undefined],
    ['avatar', 'initial', 'font-kui-avatar', 'font-bold'],
    ['stat', undefined, 'rounded-kui-card', undefined],
    ['stat', 'value', 'font-semibold', 'tabular-nums'],
    ['header', undefined, 'gap-2', undefined],
    ['header', 'title', 'text-xl', 'tracking-tight'],
    ['section', 'head', 'flex', 'mb-4'],
    ['empty', undefined, 'py-16', undefined],
    ['empty', 'description', 'text-kui-overlay1', 'italic'],
    ['row', undefined, 'group/row', undefined],
    ['row', 'body', 'min-w-0', 'px-4'],
    ['widget', undefined, 'p-4', undefined],
    ['widget', 'head', 'flex', 'pb-2'],
    ['widget', 'title', 'min-w-0', 'text-sm'],
    ['meter', undefined, 'bg-kui-surface0', undefined],
    ['meter', 'fill', 'bg-red-500', 'rounded-full'],
    ['skeleton', undefined, 'flex', 'opacity-60'],
    ['skeleton', 'block', 'animate-pulse', 'rounded-full'],
    ['progress', undefined, 'overflow-hidden', 'h-3'],
    ['progress', 'fill', 'bg-kui-accent', 'bg-lime-500'],
  ] as const)('%s %s draws its base, then what src/ui.ts sets after it', (id, part, base, restyle) => {
    const classes = classesOfPart(id, part)

    expect(classes).toContain(base)

    if (restyle !== undefined)
      expect(classes.at(-1)).toBe(restyle)
  })

  test('only a root keeps a kui class, and no part writes the class of its old rule', () => {
    for (const [id, part] of [['avatar', 'initial'], ['stat', 'value'], ['header', 'title'], ['section', 'head'], ['empty', 'description'], ['row', 'body'], ['widget', 'head'], ['meter', 'fill'], ['skeleton', 'block'], ['progress', 'fill']] as const)
      expect(classesOfPart(id, part).filter(name => name.startsWith('kui-') && name !== 'kui-heading-section'), `${id} ${part}`).toEqual([])

    expect(html).not.toMatch(REMOVED_CLASS)
  })

  test('a Meter\'s fillClass comes after the accent it replaces', () => {
    expect(classesOfPart('meter', 'fill').slice(0, 2)).toEqual(['bg-kui-accent', 'bg-red-500'])
  })
})

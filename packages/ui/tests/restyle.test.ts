import { existsSync } from 'node:fs'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { kay } from '../../../src/build/plugin'
import { child } from '../../../src/runtime/html'

// An app of its own, as `src/ui.ts` restyles every instance of a component in the app: the library's fixture app renders the same components untouched, and its contract tests compare them. Built apart from testSite, which serves one project per test process.
const ROOT = join(import.meta.dir, 'restyle-app')
const LIBRARY = join(import.meta.dir, '..')
const LINK = join(ROOT, 'node_modules', '@kaynooo', 'kayjs-ui')
const OUT = join(ROOT, 'node_modules', '.cache', 'out')
const MARKERS = /<!--[[\]]-->/g

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

describe('restyling a component of kayjs-ui from src/ui.ts', () => {
  // Each part keeps the kui class theme.css styles, then takes what the app's src/ui.ts sets on it, and the caller's class object comes last.
  const restyled = [
    'kui-card rounded-xl',
    'kui-card-head p-6',
    'kui-card-title italic',
    'kui-card-body p-9',
    'kui-btn kui-btn-danger bg-red-600',
    'kui-btn tracking-wide',
    'kui-badge bg-green-100',
    'kui-notice border-2',
    'kui-field-input h-12',
    'kui-field-input min-h-32',
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
    'kui-avatar-initial font-bold',
    'kui-stat-value tabular-nums',
    'kui-page-header-title tracking-tight',
    'kui-page-section-head mb-4',
    'kui-empty-state-description italic',
    'kui-card-row-body px-4',
    'kui-date-input gap-2',
    'kui-field-input h-12 kui-date-input-box w-44',
    'kui-date-range-input-separator mx-1',
    'kui-field-input h-12 kui-time-input w-32',
    'kui-form-field-hint text-xs',
    'kui-form-field-label gap-1',
    'kui-checkbox-input size-5',
    'kui-checkbox-hint opacity-70',
    'kui-toggle-track w-12',
    'kui-field-input pr-8',
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
    'kui-slider-label font-medium',
    'kui-slider-value tabular-nums',
    'kui-bar-list-row py-1',
    'kui-bar-list-label font-medium',
    'kui-bar-list-track h-2',
    'kui-chip rounded-full',
    'kui-collapsible-section-summary py-3',
    'kui-collapsible-section-body pt-2',
    'kui-widget-head pb-2',
    'kui-heading-section kui-widget-title text-sm',
    'bg-red-500 kui-meter-fill rounded-full',
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
    'kui-icon-btn rounded-full kui-carousel-step size-12',
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
    'kui-skeleton opacity-60',
    'kui-skeleton-block rounded-full',
    'kui-progress h-3',
    'kui-progress-fill bg-lime-500',
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
  ]

  test.each(restyled)('draws class="%s"', (classes) => {
    expect(html).toContain(`class="${classes}"`)
  })

  test('a button with an onClick takes the restyle of Button once, not twice', () => {
    expect(html).toMatch(/<button[^>]* id="busy"[^>]* class="kui-btn tracking-wide">/)
  })

  test('a busy button and a busy link draw the spinner part restyled, a button with an onClick its own spinner part', () => {
    expect(html.match(/class="kui-icon kui-spinner size-5"/g)).toHaveLength(2)
    expect(html.match(/class="kui-icon kui-spinner"/g)).toHaveLength(1)
  })

  test('an IconButton and the trigger of a Menu take the restyle, a Menu class string going to the trigger', () => {
    expect(html).toMatch(/<button[^>]* id="icon-button"[^>]* class="kui-shell kui-icon-btn rounded-full">/)
    expect(html).toMatch(/aria-haspopup="menu"[^>]* class="kui-icon-btn rounded-full menu-trigger">/)
  })

  test('a class string on a button with an onClick joins the restyle', () => {
    expect(html).toMatch(/<button[^>]* id="single"[^>]* class="kui-btn rounded-none">/)
  })

  test('the browser build of an island carries the restyled classes as well', () => {
    for (const classes of ['text-xl', 'justify-end', 'uppercase', 'py-4', 'h-12', 'tracking-wide', 'rounded-none', 'w-72', 'h-9'])
      expect(browser).toContain(classes)
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
    expect(html).toMatch(/<button[^>]*data-part="step"[^>]*class="kui-icon-btn rounded-full kui-carousel-step size-12"/)
    expect(html).toMatch(/<svg[^>]*data-part="sortIcon"/)
  })

  test('a part nothing restyles keeps its kui class alone', () => {
    expect(html).toContain('class="kui-dialog-body"')
    expect(html).toContain('class="kui-table-row"')
  })
})

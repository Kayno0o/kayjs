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
  ]

  test.each(restyled)('draws class="%s"', (classes) => {
    expect(html).toContain(`class="${classes}"`)
  })

  test('a button with an onClick takes the restyle of Button once, not twice', () => {
    expect(html).toMatch(/<button id="busy"[^>]* class="kui-btn tracking-wide">/)
  })

  test('a busy button and a busy link draw the spinner part restyled, a button with an onClick its own spinner part', () => {
    expect(html.match(/class="kui-icon kui-spinner size-5"/g)).toHaveLength(2)
    expect(html.match(/class="kui-icon kui-spinner"/g)).toHaveLength(1)
  })

  test('a class string on a button with an onClick joins the restyle', () => {
    expect(html).toMatch(/<button id="single"[^>]* class="kui-btn rounded-none">/)
  })

  test('the browser build of an island carries the restyled classes as well', () => {
    for (const classes of ['text-xl', 'justify-end', 'uppercase', 'py-4', 'h-12', 'tracking-wide', 'rounded-none', 'w-72', 'h-9'])
      expect(browser).toContain(classes)
  })

  test('a part nothing restyles keeps its kui class alone', () => {
    expect(html).toContain('class="kui-dialog-body"')
    expect(html).toContain('class="kui-table-row"')
  })
})

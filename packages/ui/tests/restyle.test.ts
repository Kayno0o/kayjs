import { existsSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildClassTable } from '../../../src/build/class-table'
import { kay } from '../../../src/build/plugin'
import { uiProblems } from '../../../src/check/ui'
import { REMOVED_UI_CLASSES } from '../../../src/check/ui-classes'
import { installClassTable } from '../../../src/runtime/class-table'
import { child } from '../../../src/runtime/html'
import { scratchDir } from '../../../tests/scratch'
import { CHECKBOX, FIELD_MESSAGE } from '../src/field-look'

// An app of its own, as `src/ui.ts` restyles every instance of a component in the app: the library's fixture app renders the same components untouched, and its contract tests compare them. Built apart from testSite, which serves one project per test process.
const ROOT = join(import.meta.dir, 'restyle-app')
const LIBRARY = join(import.meta.dir, '..')
const LINK = join(ROOT, 'node_modules', '@kaynooo', 'kayjs-ui')
const OUT = join(ROOT, 'node_modules', '.cache', 'out')
const MARKERS = /<!--[[\]]-->/g
const REMOVED_CLASS = new RegExp(Object.keys(REMOVED_UI_CLASSES).map(name => `(?<![\\w-])${name}(?![\\w-])`).join('|'))

let html = ''
let browser = ''
let renderPage: (props: Record<string, unknown>) => unknown

beforeAll(async () => {
  if (!existsSync(LINK)) {
    await mkdir(dirname(LINK), { recursive: true })
    await symlink(relative(dirname(LINK), LIBRARY), LINK)
  }

  const build = await Bun.build({ entrypoints: [join(ROOT, 'src/entry.ts')], outdir: OUT, target: 'bun', plugins: [kay({ root: ROOT, target: 'ssr' })] })

  if (!build.success)
    throw new AggregateError(build.logs, 'build failed')

  const { Page } = await import(build.outputs[0]!.path) as { Page: (props: Record<string, unknown>) => unknown }

  renderPage = Page
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
    'kui-field-input kui-range-input-box w-24',
    'kui-range-input-unit ml-1',
    'kui-collapsible-section-summary py-3',
    'kui-collapsible-section-body pt-2',
    'kui-save-bar sticky',
    'kui-save-bar-status italic',
    'kui-save-bar-actions gap-4',
    'kui-split-layout-sidebar-head h-14',
    'kui-split-layout-list overflow-auto',
    'kui-split-layout-detail p-6',
    'kui-split-layout-resizer w-2',
    'kui-tree-view-item py-1',
    'kui-tree-view-label truncate',
    'kui-virtual-list h-96',
    'kui-icon-grid gap-3',
    'kui-icon-grid-bar pt-2',
    'kui-markdown-grid gap-6',
    'kui-markdown-bar px-4',
    'kui-accordion gap-5',
    'kui-form-grid gap-5',
    'kui-contact-form gap-7',
    'kui-when-visible min-h-4',
    'kui-icon kui-collapsible-section-chevron size-6',
    'kui-icon kui-tree-view-icon size-3',
    'kui-load-more py-6',
    'kui-field-input h-11',
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
    expect(classesOfTag('id="icon-button"')).toEqual(expect.arrayContaining(['kui-shell', 'kui-icon-btn']))
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
    expect(html).toMatch(/<p class="kui-bar-list-empty[^"]* kui-bar-list [^"]*text-gray-500" data-part="root" id="bars-empty">/)
    expect(html).toMatch(/<p class="kui-media-gallery-empty[^"]* kui-media-gallery [^"]*text-center"[^>]*id="gallery-empty"/)
  })

  test('a component used as a part of another keeps the part name its caller hands it', () => {
    expect(html).toMatch(/<svg[^>]*data-part="spinner"/)
    expect(classesOfTag('data-part="step"', 'button').filter(name => name === 'kui-icon-btn')).toHaveLength(1)
    expect(classesOfTag('data-part="step"', 'button').filter(name => name.startsWith('data-[side='))).toHaveLength(2)
    expect(classesOfTag('data-part="step"', 'button').at(-1)).toBe('size-12')
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
})

describe('the charts and media whose recipe holds their look', () => {
  // The classes of every element carrying the part, in the order they are written.
  const partsNamed = (part: string) => [...html.matchAll(new RegExp(`<[a-z0-9]+[^>]*data-part="${part}"[^>]*>`, 'g'))].map(([tag]) => (tag.match(/ class="([^"]*)"/)?.[1] ?? '').split(' '))

  test.each([
    ['row', 'grid', 'py-1'],
    ['label', 'truncate', 'font-medium'],
    ['track', 'col-span-2', 'h-2'],
    ['plot', 'kui-line-chart-plot', 'h-72'],
    ['legend', 'flex', 'gap-6'],
    ['legendItem', 'items-center', 'text-sm'],
    ['plot', 'col-start-2', 'aspect-video'],
    ['cell', 'transition-transform', 'rounded-full'],
    ['month', 'row-start-1', 'font-medium'],
    ['viewport', 'bg-kui-surface0', 'rounded-3xl'],
    ['dot', 'after:absolute', 'size-4'],
    ['stage', 'touch-pan-y', 'rounded-3xl'],
    ['thumb', 'aspect-video', 'opacity-80'],
    ['counter', 'tabular-nums', 'font-mono'],
    ['stage', 'cursor-crosshair', 'bg-black'],
    ['tools', 'absolute', 'gap-2'],
    ['img', 'object-contain', 'rounded-sm'],
    ['plot', 'ml-10', 'h-64'],
    ['column', 'items-end', 'px-px'],
    ['bar', 'min-h-px', 'rounded-t-md'],
    ['axisLabel', 'justify-center', 'font-mono'],
    ['tile', 'min-w-0', 'rounded-xl'],
    ['legendItem', 'items-center', 'gap-2'],
  ] as const)('the %s part with %s draws what src/ui.ts sets after its base: %s', (part, base, restyle) => {
    const found = partsNamed(part).filter(classes => classes.includes(base))

    expect(found.length).toBeGreaterThan(0)
    expect(found.some(classes => classes.at(-1) === restyle)).toBe(true)
  })

  test.each([
    ['kui-masonry', 'p-3'],
    ['kui-zoom-pane', 'h-96'],
    ['kui-qr-code', 'rounded-lg'],
    ['kui-site-favicon', 'size-6'],
  ] as const)('the root %s draws what src/ui.ts sets after its base: %s', (root, restyle) => {
    const found = [...html.matchAll(/<[a-z0-9][^>]*class="([^"]*)"[^>]*>/g)].map(([, classes]) => classes!.split(' ')).filter(classes => classes.includes(root))

    expect(found.some(classes => classes.at(-1) === restyle)).toBe(true)
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
  ] as const)('%s %s draws its base, then what src/ui.ts sets after it', (id, part, base, restyle) => {
    const classes = classesOfPart(id, part)

    expect(classes).toContain(base)

    if (restyle !== undefined)
      expect(classes.at(-1)).toBe(restyle)
  })

  test('a Button leaves its padding and size to the per-size rules, and its pointer to an enabled one', () => {
    const classes = classesOfPart('plain')

    for (const name of ['px-3', 'py-1', 'text-xs', 'cursor-pointer'])
      expect(classes, name).not.toContain(name)

    expect(classes).toContain('enabled:not-aria-busy:cursor-pointer')
  })

  test('a DateInput and a TimeInput draw the field look, then what src/ui.ts sets on them', () => {
    const date = classesOfPart('date', 'input')
    const time = classesOfPart('time')

    expect(date[0]).toBe('kui-field-input')
    expect(date.slice(-5)).toEqual(['h-12', 'min-w-0', 'flex-1', 'tabular-nums', 'w-44'])
    expect(time[0]).toBe('kui-field-input')
    expect(time.slice(-3)).toEqual(['h-12', 'kui-time-input', 'w-32'])
  })

  test('with the class table installed, what src/ui.ts sets replaces the utility it overrides', async () => {
    const dir = await scratchDir('restyle-merge-')
    const words = new Set(html.match(/ class="[^"]*"/g)?.flatMap(attribute => attribute.slice(8, -1).split(' ')))

    await Bun.write(join(dir, 'src', 'app.css'), '@import "tailwindcss";\n@theme { --tracking-kui-action: 0.05em; }\n')

    try {
      installClassTable(await buildClassTable(dir, words, []))

      const merged = child(renderPage({})).replace(MARKERS, '')
      const classesOf = (id: string, part?: string) => {
        const start = part === undefined ? merged.indexOf(`id="${id}"`) : merged.indexOf(`data-part="${part}"`, merged.indexOf(`id="${id}"`))

        return (merged.slice(merged.lastIndexOf('<', start), merged.indexOf('>', start)).match(/ class="([^"]*)"/)?.[1] ?? '').split(' ')
      }

      expect(classesOf('busy')).not.toContain('tracking-kui-action')
      expect(classesOf('busy').at(-1)).toBe('tracking-wide')
      expect(classesOf('checkbox', 'input')).not.toContain('size-4')
      expect(classesOf('checkbox', 'input').at(-1)).toBe('size-5')
      expect(classesOf('toggle', 'track')).not.toContain('w-9')
      expect(classesOf('toggle', 'track').at(-1)).toBe('w-12')

      const compact = (merged.match(/<div class="(kui-form-field [^"]*)" data-part="root" data-kui-field="[^"]*" data-compact/)?.[1] ?? '').split(' ')

      expect(compact).not.toContain('w-auto')
      expect(compact).not.toContain('w-full')
      expect(compact.at(-1)).toBe('w-48')
    }
    finally {
      installClassTable(undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('only a root keeps a kui class, and the label type FormField shares with Table', () => {
    for (const [id, part] of [['field', 'hint'], ['field', 'label'], ['field', 'head'], ['field', 'required'], ['checkbox', 'input'], ['checkbox', 'hint'], ['toggle', 'input'], ['toggle', 'track']] as const)
      expect(classesOfPart(id, part).filter(name => name.startsWith('kui-')), `${id} ${part}`).toEqual([])

    expect(classesOfPart('field', 'text')[0]).toBe('kui-label-text')
  })

  test('a compact FormField is auto-wide by a recipe variant, so a class on it replaces the width and a plain one stays full-width', () => {
    const compact = (html.match(/<div class="(kui-form-field [^"]*)" data-part="root" data-kui-field="[^"]*" data-compact/)?.[1] ?? '').split(' ')

    expect(compact).toContain('w-auto')
    expect(compact).not.toContain('data-compact:w-auto')
    expect(compact.at(-1)).toBe('w-48')
    const plain = (html.match(/<div class="(kui-form-field [^"]*)" data-part="root" data-kui-field="[^"]*">/)?.[1] ?? '').split(' ')

    expect(plain).toContain('w-full')
    expect(plain).not.toContain('w-auto')
  })

  test('the consent box of a ContactForm draws the Checkbox look and its messages the FormField ones, from the same utilities', () => {
    const start = html.indexOf('data-part="consent"')
    const consent = html.slice(start, html.indexOf('data-part="issues"', start))
    const classOf = (part: string) => consent.match(new RegExp(`class="([^"]*)" data-part="${part}"`))?.[1]

    expect(classOf('box')).toBe(CHECKBOX.root)
    expect(classOf('boxInput')).toBe(CHECKBOX.input)
    expect(classOf('boxLabel')).toBe(CHECKBOX.label)
    expect(classOf('box')).toContain('has-[input:disabled]:opacity-50')
    expect(html).toContain(`class="${FIELD_MESSAGE.issues}" data-part="issues"`)
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

describe('the remaining field and button components whose recipe holds their look', () => {
  // The class tokens of every tag drawing the part, matched whatever the attribute order.
  const TAG = /<\w+(?: [\w:-]+(?:="[^"]*")?)*>/g
  const tokensOf = (part: string) =>
    [...html.matchAll(TAG)]
      .filter(match => (part === 'root' && !match[0].includes(' data-part=')) || match[0].includes(`data-part="${part}"`))
      .map(match => ((/ class="([^"]*)"/).exec(match[0])?.[1] ?? '').split(' '))
  const drawn = (part: string, base: string, restyle: string) => tokensOf(part).some(tokens => tokens.includes(base) && tokens.at(-1) === restyle)

  test.each([
    ['root', 'kui-date-input', 'gap-2'],
    ['separator', 'text-kui-subtext0', 'mx-1'],
    ['trigger', 'data-empty:text-kui-overlay1', 'min-w-40'],
    ['option', 'has-[[data-part=checkbox]:disabled]:opacity-50', 'py-2'],
    ['action', 'hover:text-kui-text', 'underline'],
    ['option', 'group-aria-busy/segmented:cursor-progress', 'px-5'],
    ['icon', 'size-3.5', 'size-3'],
    ['stars', 'w-max', 'text-amber-500'],
    ['root', 'kui-file-drop', 'border-dotted'],
    ['root', 'kui-copy-btn', 'ring-2'],
    ['text', 'after:content-[attr(data-other)]', 'font-mono'],
    ['label', '[font-family:var(--kui-label-font,inherit)]', 'font-medium'],
    ['value', 'text-kui-text', 'tabular-nums'],
    ['label', 'text-kui-micro', 'font-medium'],
    ['chip', 'group-aria-busy/chips:cursor-progress', 'rounded-full'],
    ['root', 'group/radios', 'gap-5'],
    ['choice', 'self-start', 'p-2'],
    ['label', 'text-kui-text', 'font-medium'],
    ['description', 'pl-6', 'text-xs'],
    ['root', 'kui-combobox', 'gap-2'],
    ['option', 'aria-selected:bg-kui-row-hover', 'py-2'],
    ['status', 'sr-only', 'text-xs'],
  ] as const)('draws the %s part with %s, then what src/ui.ts sets: %s', (part, base, restyle) => {
    expect(drawn(part, base, restyle)).toBe(true)
  })

  test('keeps the kui class of a root, a chip and the combobox input as names, and no other part sets one', () => {
    for (const name of ['kui-date-input', 'kui-segmented', 'kui-rating', 'kui-slider', 'kui-color-input', 'kui-chip-group', 'kui-chip', 'kui-file-drop', 'kui-copy-btn', 'kui-radio-group', 'kui-combobox', 'kui-multi-select', 'kui-date-range-input'])
      expect(html, name).toMatch(new RegExp(`class="(?:[^"]* )?${name}[ "]`))

    expect(html).not.toMatch(REMOVED_CLASS)
  })

  test('the browser build of a ChipGroup, a RadioGroup and a Segmented selects its inputs by data-part', () => {
    expect(browser).not.toMatch(/kui-(?:chip|radio|segmented)-input/)
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

describe('the tables and navigation whose recipe holds their look', () => {
  // The classes of the element a data-part under an id selects, in the order they are written.
  const partClasses = (id: string, part: string) => {
    const root = html.indexOf(`id="${id}"`)
    const start = part === 'root' ? root : html.indexOf(`data-part="${part}"`, root)

    return (html.slice(html.lastIndexOf('<', start), html.indexOf('>', start)).match(/ class="([^"]*)"/)?.[1] ?? '').split(' ')
  }

  test.each([
    ['table', 'root', 'overflow-x-auto', 'gap-3'],
    ['table', 'table', 'border-collapse', 'text-sm'],
    ['table', 'headCell', 'px-3', 'uppercase'],
    ['table', 'cell', 'text-kui-text', 'py-4'],
    ['table', 'sortIcon', 'size-3.5', 'size-4'],
    ['table', 'filterInput', 'max-w-full', 'w-64'],
    ['table', 'count', 'sr-only', 'text-xs'],
    ['table', 'selection', 'sticky', 'mb-2'],
    ['tabs', 'tab', 'border-b-2', 'px-5'],
    ['tabs', 'panel', 'pt-4', undefined],
    ['tabs', 'icon', 'shrink-0', 'size-3'],
    ['tabnav', 'link', 'border-b-2', 'font-semibold'],
    ['sitenav', 'link', 'text-kui-subtext0', 'rounded-md'],
    ['sitenav', 'list', 'lg:flex', 'gap-3'],
    ['sitenav', 'menuIcon', 'group-has-[[data-part=list]:popover-open]/nav:hidden', 'size-6'],
    ['appheader', 'brand', 'min-w-0', 'text-lg'],
    ['appheader', 'end', 'min-w-0', 'ml-auto'],
    ['pager', 'step', 'min-w-9', 'px-4'],
    ['pager', 'page', 'border-kui-surface2', 'min-w-10'],
    ['pager', 'gap', 'text-kui-overlay1', 'opacity-50'],
    ['breadcrumb', 'list', 'flex-wrap', 'gap-4'],
    ['breadcrumb', 'link', 'hover:underline', 'underline'],
    ['breadcrumb', 'text', 'aria-[current=page]:text-kui-text', 'font-bold'],
    ['steps', 'list', 'flex-wrap', 'gap-4'],
    ['steps', 'marker', 'rounded-full', 'size-8'],
    ['steps', 'state', 'sr-only', undefined],
  ] as const)('%s %s draws its base, then what src/ui.ts sets after it', (id, part, base, restyle) => {
    const classes = partClasses(id, part)

    expect(classes).toContain(base)

    if (restyle !== undefined)
      expect(classes.at(-1)).toBe(restyle)
  })

  test('sets a kui class on a root alone, and none of the parts they dropped', () => {
    expect(partClasses('table', 'root')[0]).toBe('kui-table-wrap')

    for (const [id, part] of [['table', 'row'], ['table', 'cell'], ['table', 'table'], ['tabs', 'tab'], ['sitenav', 'list'], ['pager', 'step'], ['breadcrumb', 'item'], ['steps', 'marker']] as const)
      expect(partClasses(id, part).filter(name => name.startsWith('kui-')), `${id} ${part}`).toEqual([])

    expect(html).not.toMatch(REMOVED_CLASS)
  })

  test('a stacked Table reads its narrow form from a container named without the kui prefix', () => {
    const root = partClasses('table', 'root')

    expect(root).toContain('data-[narrow=stack]:@container/table')
    expect(partClasses('table', 'row')).toContain('@max-[30rem]/table:grid')
  })
})

describe('the overlays whose recipe holds their look', () => {
  // The classes of the element a data-part selects, from the element an id names, or the root a kui class names when it takes no id. A part written as 'footer#2' is the second one after it.
  const classesOfPart = (id: string, part?: string) => {
    const root = id.startsWith('kui-') ? html.indexOf(`class="${id} `) : html.indexOf(`id="${id}"`)
    const [name = '', nth = '1'] = (part ?? '').split('#')
    let start = root

    for (let at = 0; at < (part === undefined ? 0 : Number(nth)); at++)
      start = html.indexOf(`data-part="${name}"`, start + 1)

    const tag = html.slice(html.lastIndexOf('<', start), html.indexOf('>', start))

    return (tag.match(/ class="([^"]*)"/)?.[1] ?? '').split(' ')
  }

  test.each([
    ['dialog', undefined, 'overflow-hidden', undefined],
    ['dialog', 'title', 'shrink-0', 'text-xl'],
    ['dialog', 'body', 'overflow-y-auto', undefined],
    ['menu', 'list', 'flex-col', 'min-w-48'],
    ['menu', 'item', 'cursor-pointer', 'py-3'],
    ['popover', undefined, 'bg-kui-mantle', 'shadow-xl'],
    ['side', undefined, 'h-dvh', undefined],
    ['side', 'head', 'border-b', 'px-6'],
    ['side', 'title', 'truncate', 'text-lg'],
    ['side', 'body', 'overflow-y-auto', 'px-6'],
    ['kui-command-palette', undefined, 'max-h-[min(70dvh,40rem)]', 'rounded-2xl'],
    ['kui-toaster', undefined, 'fixed', 'z-50'],
    ['kui-tooltip', undefined, 'bg-kui-surface1', 'text-xs'],
    ['form-dialog', 'footer#2', 'items-center', 'pt-4'],
    ['form-dialog', 'actions', 'ml-auto', 'gap-3'],
  ] as const)('%s %s draws its base, then what src/ui.ts sets after it', (id, part, base, restyle) => {
    const classes = classesOfPart(id, part)

    expect(classes).toContain(base)

    if (restyle !== undefined)
      expect(classes.at(-1)).toBe(restyle)
  })

  test('only a root keeps a kui class, and no part writes the class of its old rule', () => {
    for (const [id, part] of [['dialog', 'title'], ['dialog', 'body'], ['menu', 'list'], ['menu', 'item'], ['side', 'head'], ['side', 'body'], ['form-dialog', 'footer#2'], ['form-dialog', 'actions']] as const)
      expect(classesOfPart(id, part).filter(name => name.startsWith('kui-')), `${id} ${part}`).toEqual([])

    expect(html).not.toMatch(REMOVED_CLASS)
  })

  test('a Dialog size is a variant of its root that replaces the width, and a bare body writes data-bare', () => {
    expect(html.match(/<dialog[^>]*id="dialog"[^>]*>/)![0]).not.toContain('data-size')
    // The merge that drops the base width needs the class table of a built app; here the variant comes after the base, which is what it reads.
    expect(classesOfPart('dialog').filter(name => name.startsWith('max-w-'))).toEqual(['max-w-[min(42rem,calc(100vw-2rem))]'])
    expect(classesOfPart('small').filter(name => name.startsWith('max-w-')).at(-1)).toBe('max-w-[min(28rem,calc(100vw-2rem))]')
    expect(classesOfPart('full').filter(name => name.startsWith('max-w-')).at(-1)).toBe('max-w-[calc(100vw-2rem)]')
    expect(classesOfPart('full')).toContain('h-[calc(100dvh-2rem)]')
    expect(html.match(/<div[^>]*data-part="body"[^>]*>/g)!.filter(tag => (/ data-bare[ =>]/).test(tag))).toHaveLength(1)
    expect(html.match(/<dialog[^>]*id="full"[\s\S]*?<div[^>]*data-part="body"[^>]*>/)![0]).toMatch(/ data-bare[ =>]/)
  })
})

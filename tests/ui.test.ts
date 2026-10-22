import type { Reached } from '../src/build/styles'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { kay } from '../src/build/plugin'
import { styleImports } from '../src/build/styles'
import { transformKayCached } from '../src/build/transform'
import { uiEntryOf, uiOf } from '../src/build/ui'
import { uiProblems } from '../src/check/ui'
import { compileKay } from '../src/compiler'
import { devBuilder } from '../src/dev/builder'
import { projectPaths } from '../src/project'
import { installClassTable } from '../src/runtime/class-table'
import { child } from '../src/runtime/html'
import { settle } from '../src/test'
import { scratchDir } from './scratch'

setDefaultTimeout(90_000)

const scratch = await scratchDir('ui-')
const MARKERS = /<!--[[\]]-->/g
const CARD = `---
import { recipe } from 'kay'

const card = recipe({
  parts: { root: 'card p-4', head: 'p-2', body: 'm-2' },
  variants: { tone: { plain: {}, danger: { head: 'text-red-700' } } },
  defaults: { tone: 'plain' },
})
const { title, items = [], open = false } = props<{ title: string, items?: string[], open?: boolean }>()
---
section
  header(part="head") {title}
  if open
    p(part="note") note
  ul
    for item of items
      li(part="item") {item}
  div(part="body")
    slot
`
const UI = `import { defineUi } from 'kay'

export default defineUi({
  './card.kay': {
    parts: { head: 'p-6 font-bold', root: 'rounded-xl', item: 'italic', note: 'text-sm' },
    variants: { tone: { plain: { head: 'bg-white' }, danger: { head: 'bg-red-100' } } },
  },
  'uilib/card.kay': { parts: { head: 'p-9' } },
  './plain.kay': { parts: { head: 'font-bold' } },
})
`
const files: Record<string, string> = {
  'src/card.kay': CARD,
  'src/untouched.kay': CARD,
  'src/plain.kay': 'section.card\n  header(part="head") a\n',
  'src/no-parts.kay': 'div.box a\n',
  'src/switch.kay': '---\nimport Card from \'./card.kay\'\nconst tone = signal<\'plain\' | \'danger\'>(\'plain\')\n---\nbutton(onClick={() => tone.set(\'danger\')}) swap\nCard(title="t" tone={tone()}) body\n',
  'node_modules/uilib/card.kay': '---\nconst { title } = props<{ title: string }>()\n---\nsection.card.p-4\n  header.p-2(part="head") {title}\n',
  'src/entry.ts': 'export { default as Card } from \'./card.kay\'\nexport { default as Untouched } from \'./untouched.kay\'\nexport { default as Plain } from \'./plain.kay\'\nexport { default as Library } from \'uilib/card.kay\'\nexport { default as Switch } from \'./switch.kay\'\nexport { render } from \'kay/dom\'\n',
}

type Component = (props: Record<string, unknown>) => unknown

async function bundle(target: 'bun' | 'browser', dir: string): Promise<Record<string, Component> & { render: (fn: () => unknown, element: Element) => () => void }> {
  const build = await Bun.build({ entrypoints: [join(scratch, 'src/entry.ts')], outdir: join(scratch, dir), target, plugins: [kay({ root: scratch, target: target === 'bun' ? 'ssr' : 'dom' })] })

  if (!build.success)
    throw new AggregateError(build.logs, 'build failed')

  return await import(build.outputs[0]!.path) as never
}

function html(component: Component, props: Record<string, unknown> = {}): string {
  return child(component(props)).replace(MARKERS, '')
}

beforeAll(async () => {
  await Promise.all(Object.entries(files).map(async ([name, text]) => Bun.write(join(scratch, name), text)))
  // Two `p-` classes set the same property, as Tailwind's table would say; so do `m-` ones.
  installClassTable({ sets: [[1], [2]], classes: { 'p-2': [0, 0], 'p-4': [0, 0], 'p-6': [0, 0], 'p-8': [0, 0], 'p-9': [0, 0], 'm-2': [1, 0], 'm-4': [1, 0] } })
})

afterAll(async () => {
  installClassTable(undefined)
  await rm(scratch, { recursive: true, force: true })
})

describe('an app with no src/ui.ts', () => {
  it('compiles a component with parts as it did, with no ui constant', async () => {
    const source = await Bun.file(join(scratch, 'src/card.kay')).text()
    const { tsx } = compileKay(source, join(scratch, 'src/card.kay'), { root: scratch, output: 'html' })

    expect(tsx).not.toContain('KayUi')
    expect(uiOf(scratch)).toBeUndefined()
    expect(uiEntryOf(scratch, join(scratch, 'src/card.kay'))).toBeUndefined()
  })

  it('renders the recipe and the caller\'s class alone', async () => {
    const server = await bundle('bun', 'out-none')

    expect(html(server.Card!, { title: 't', class: { head: 'p-8' } })).toContain('<header class="p-8" data-part="head">t</header>')
  })
})

describe('src/ui.ts on the server', () => {
  let server!: Record<string, Component>

  beforeAll(async () => {
    await Bun.write(join(scratch, 'src/ui.ts'), UI)
    server = await bundle('bun', 'out-server')
  })

  it('puts its parts after the recipe\'s and before the caller\'s class', () => {
    expect(html(server.Card!, { title: 't' })).toContain('<section class="card p-4 rounded-xl"><header class="p-6 font-bold bg-white" data-part="head">t</header>')
    expect(html(server.Card!, { title: 't', class: { head: 'p-8' } })).toContain('<header class="font-bold bg-white p-8" data-part="head">t</header>')
  })

  it('puts the variants after the recipe\'s, and reads the recipe\'s defaults', () => {
    expect(html(server.Card!, { title: 't', tone: 'danger' })).toContain('<header class="text-red-700 p-6 font-bold bg-red-100" data-part="head">t</header>')
    expect(html(server.Card!, { title: 't', tone: 'plain' })).toContain('class="p-6 font-bold bg-white"')
  })

  it('reaches a part inside an if and a for, and the root', () => {
    const page = html(server.Card!, { title: 't', open: true, items: ['x', 'y'] })

    expect(page).toContain('<p class="text-sm" data-part="note">note</p>')
    expect(page).toContain('<li class="italic" data-part="item">x</li><li class="italic" data-part="item">y</li>')
    expect(page).toContain('<div class="m-2" data-part="body"></div>')
  })

  it('leaves a component it does not name alone', () => {
    expect(html(server.Untouched!, { title: 't' })).toContain('<section class="card p-4"><header class="p-2" data-part="head">t</header>')
  })

  it('writes the parts of an entry with no variants as static classes of the component', async () => {
    expect(html(server.Plain!)).toBe('<section class="card"><header class="font-bold" data-part="head">a</header></section>')

    const source = await Bun.file(join(scratch, 'src/plain.kay')).text()
    const { tsx } = compileKay(source, join(scratch, 'src/plain.kay'), { root: scratch, output: 'html', ui: uiEntryOf(scratch, join(scratch, 'src/plain.kay')) })

    expect(tsx).not.toContain('KayUi')
    expect(tsx).toContain('"font-bold"')
  })

  it('restyles a library component compiled from node_modules', () => {
    expect(html(server.Library!, { title: 'lib' })).toBe('<section class="card p-4"><header class="p-9" data-part="head">lib</header></section>')
  })
})

describe('src/ui.ts in an island', () => {
  it('renders the classes the server renders and swaps a variant\'s classes at runtime', async () => {
    GlobalRegistrator.register()

    try {
      const client = await bundle('browser', 'out-client')
      const root = document.createElement('div')

      document.body.append(root)

      const stop = client.render(() => client.Switch!({}), root)
      const header = () => root.querySelector('header')?.getAttribute('class')

      expect(header()).toBe('p-6 font-bold bg-white')
      root.querySelector('button')?.click()
      await settle()
      expect(header()).toBe('text-red-700 p-6 font-bold bg-red-100')
      expect(root.querySelector('header')?.getAttribute('data-part')).toBe('head')
      stop()
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })
})

describe('the compiled classes', () => {
  it('are recompiled when src/ui.ts changes', async () => {
    const file = join(scratch, 'src/card.kay')
    const source = await Bun.file(file).text()
    const cacheDir = join(scratch, '.cache')
    const compile = async () => transformKayCached(source, file, { target: 'ssr', root: scratch, cacheDir })

    expect(await compile()).toContain('p-6 font-bold')
    await Bun.write(join(scratch, 'src/ui.ts'), UI.replace('p-6 font-bold', 'p-7'))
    expect(await compile()).toContain('p-7')
    expect(await compile()).not.toContain('font-bold')
    await Bun.write(join(scratch, 'src/ui.ts'), UI)
  })
})

describe('hostile entries', () => {
  it('never breaks the generated code or the markup, whatever the classes hold', async () => {
    const nasty = 'a" onclick="x \u2028 ${1} `b` \\'

    await Bun.write(join(scratch, 'src/ui.ts'), `export default { './plain.kay': { parts: { head: ${JSON.stringify(nasty)} } }, './card.kay': { variants: { __proto__: { x: 'y' }, tone: { plain: { head: ${JSON.stringify(nasty)} } } } } }`)

    const server = await bundle('bun', 'out-hostile')

    expect(html(server.Plain!)).toBe(`<section class="card"><header class="a&quot; onclick=&quot;x \u2028 \${1} \`b\` \\" data-part="head">a</header></section>`)
    expect(html(server.Card!, { title: 't' })).toContain('data-part="head"')
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    expect(Object.hasOwn(uiOf(scratch)!.components[1]!.entry.variants!, '__proto__')).toBe(true)
    await rm(join(scratch, 'src/ui.ts'))
  })
})

describe('the styles a page keeps', () => {
  it('reach src/ui.ts from the components it restyles, so a page using one keeps the rules of the classes written there', async () => {
    await Bun.write(join(scratch, 'src/ui.ts'), UI)
    await Bun.write(projectPaths(scratch).classes, '')

    const reached: Reached = { edges: new Map(), open: new Set() }

    await Bun.build({ entrypoints: [join(scratch, 'src/card.kay'), join(scratch, 'src/untouched.kay')], plugins: [styleImports(scratch, [], undefined, reached)] })

    expect(reached.edges.get(join(scratch, 'src/card.kay'))).toContain(join(scratch, 'src/ui.ts'))
    expect(reached.edges.get(join(scratch, 'src/untouched.kay'))).toEqual([])
    await rm(join(scratch, 'src/ui.ts'))
  })
})

describe('kay dev', () => {
  it('rebuilds the islands when src/ui.ts changes', async () => {
    const project = await scratchDir('ui-dev-')
    const ui = (head: string) => `export default { './card.kay': { parts: { head: '${head}' }, variants: { tone: { danger: { head: 'x-${head}' } } } } }`
    const chunks = async () => (await Promise.all((await readdir(clientDir(project))).filter(name => name.endsWith('.js')).map(async name => Bun.file(join(clientDir(project), name)).text()))).join('\n')
    const cwd = process.cwd()

    await Promise.all(Object.entries({
      'src/card.kay': CARD,
      'src/switch.kay': files['src/switch.kay']!,
      'src/routes/index.kay': '---\nimport Switch from \'../switch.kay\'\n---\nSwitch\n',
      'src/ui.ts': ui('p-6'),
    }).map(async ([name, text]) => Bun.write(join(project, name), text)))

    const build = devBuilder(project, { hot: true })

    try {
      process.chdir(project)
      expect((await build(null)).failed).toBe(false)
      expect(await chunks()).toContain('x-p-6')

      await Bun.write(join(project, 'src/ui.ts'), ui('p-7'))
      expect((await build(['src/ui.ts'])).failed).toBe(false)

      const rebuilt = await chunks()

      expect(rebuilt).toContain('x-p-7')
    }
    finally {
      process.chdir(cwd)
      await rm(project, { recursive: true, force: true })
    }
  })
})

describe('kay check on src/ui.ts', () => {
  const messages = async (ui: string) => {
    await Bun.write(join(scratch, 'src/ui.ts'), ui)

    return uiProblems(scratch).map(problem => problem.message)
  }

  it('accepts a file naming components, parts, variants and values they have', async () => {
    expect(await messages(UI)).toEqual([])
  })

  it('reports an unknown component, one with nothing to restyle, and one that is no .kay', async () => {
    expect(await messages('export default { \'./missing.kay\': { parts: \'a\' }, \'./no-parts.kay\': { parts: \'a\' }, \'./card.ts\': {} }')).toEqual([
      '`./missing.kay` names no component',
      '`./no-parts.kay` has no parts or variants to restyle',
      '`./card.ts` names no component',
    ])
  })

  it('reports an unknown part, variant and value, listing the known ones', async () => {
    await Bun.write(join(scratch, 'src/ui.ts'), 'export default { \'./card.kay\': { parts: { foot: \'a\' }, variants: { size: { sm: \'b\' }, tone: { loud: { head: \'c\', tail: \'d\' } } } } }')

    const problems = uiProblems(scratch)

    expect(problems.map(problem => problem.message)).toEqual([
      '`./card.kay` has no part `foot`',
      '`./card.kay` has no part `tail`',
      '`./card.kay` has no variant `size`',
      'The variant `tone` of `./card.kay` has no value `loud`',
    ])
    expect(problems[0]!.help).toContain('`head`')
    expect(problems[2]!.help).toContain('`tone`')
  })

  it('reports two keys naming one component, and a page, a layout or a server-fenced file', async () => {
    await Bun.write(join(scratch, 'src/_layout.kay'), 'main(part="root") a\n')
    await Bun.write(join(scratch, 'src/fenced.kay'), '--- server\nconst a = 1\n---\nmain(part="root") {a}\n')

    expect(await messages('export default { \'./card.kay\': { parts: { head: \'a\' } }, \'../src/card.kay\': { parts: { head: \'b\' } }, \'./_layout.kay\': { parts: \'c\' }, \'./fenced.kay\': { parts: \'d\' } }')).toEqual([
      '`../src/card.kay` names the same component as `./card.kay`',
      '`./_layout.kay` is a page, a layout or a component with a `--- server` fence',
      '`./fenced.kay` is a page, a layout or a component with a `--- server` fence',
    ])
  })

  it('reports what it cannot read as written', async () => {
    expect((await messages('const head = \'p-2\'\nexport default { \'./card.kay\': { parts: { head } } }')).some(message => message.includes('must be written as a string'))).toBe(true)
    expect((await messages('export default { \'./card.kay\': { parts: { head: `p-${2}` } } }')).some(message => message.includes('must be written as a string'))).toBe(true)
    expect((await messages('export const nothing = 1')).some(message => message.includes('no default export'))).toBe(true)
    expect((await messages('export default { \'./card.kay\': { color: \'red\' } }')).some(message => message.includes('no setting'))).toBe(true)
  })

  it('reports nothing for a project with no src/ui.ts', async () => {
    await rm(join(scratch, 'src/ui.ts'))

    expect(uiProblems(scratch)).toEqual([])
  })
})

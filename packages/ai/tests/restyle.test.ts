import { existsSync } from 'node:fs'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { kay } from '../../../src/build/plugin'
import { child } from '../../../src/runtime/html'

// An app of its own, as `src/ui.ts` restyles every instance of a component in the app. Built apart from testSite, which serves one project per test process.
const ROOT = join(import.meta.dir, 'restyle-app')
const LIBRARY = join(import.meta.dir, '..')
const UI = join(LIBRARY, '../ui')
const OUT = join(ROOT, 'node_modules', '.cache', 'out')
const SETTINGS = { '@kaynooo/kayjs-ui': './src/ui-settings.ts' }
const TABLER = join(UI, '../../node_modules/@iconify-json/tabler/icons.json')
const PATH = /\sd="([^"]+)"/
const MARKERS = /<!--[[\]]-->/g

let html = ''
let icons: Record<string, string> = {}

// The drawing of a tabler icon, as the page holds it.
const body = (name: string): string => icons[name]!

async function link(name: string, target: string): Promise<void> {
  const path = join(ROOT, 'node_modules', '@kaynooo', name)

  if (existsSync(path))
    return

  await mkdir(dirname(path), { recursive: true })
  await symlink(relative(dirname(path), target), path)
}

beforeAll(async () => {
  await link('kayjs-ai', LIBRARY)
  await link('kayjs-ui', UI)

  const build = await Bun.build({ entrypoints: [join(ROOT, 'src/entry.ts')], outdir: OUT, target: 'bun', plugins: [kay({ root: ROOT, target: 'ssr', settings: SETTINGS })] })

  if (!build.success)
    throw new AggregateError(build.logs, 'build failed')

  const { Page } = await import(build.outputs[0]!.path) as { Page: (props: Record<string, unknown>) => unknown }

  icons = Object.fromEntries(Object.entries((await Bun.file(TABLER).json() as { icons: Record<string, { body: string }> }).icons).map(([name, { body }]) => [name, body]))
  html = child(Page({})).replace(MARKERS, '')
}, 60_000)

afterAll(async () => rm(OUT, { recursive: true, force: true }))

describe('restyling the chat from src/ui.ts', () => {
  // Each part keeps the kai class chat.css styles, then takes what the app's src/ui.ts sets on it, and the caller's class comes last.
  test.each([
    'kai-chat rounded-xl',
    'kai-chat-greeting italic',
    'kai-chat-suggestion uppercase',
    'kai-chat-turn text-base',
    'kai-chat-log max-h-96',
    'kai-chat-calls-summary font-bold',
    'kai-chat-call-name tracking-wide',
    'kai-launcher-panel shadow-2xl',
    'kui-icon-btn kai-launcher-button size-16',
  ])('draws class="%s"', (classes) => {
    expect(html).toContain(`class="${classes}"`)
  })

  test('a class string joins the root after src/ui.ts, and a variant of src/ui.ts applies to its value', () => {
    expect(html).toMatch(/<section class="kai-chat rounded-xl opacity-90 rounded-lg"/)
  })

  test('the shared props reach the root as data attributes, with their defaults', () => {
    expect(html).toMatch(/<section class="kai-chat rounded-xl"[^>]* data-variant="bubble" data-tone="accent" data-size="md"/)
    expect(html).toMatch(/<section class="kai-chat rounded-xl opacity-90 rounded-lg"[^>]* data-variant="plain" data-tone="neutral" data-size="sm"/)
  })

  test('the launcher hands the shared props to its chat and its class string to its wrapper', () => {
    expect(html).toMatch(/<div class="kai-launcher mb-2"[\s\S]*?<section class="kai-chat[^"]*"[^>]* data-variant="plain" data-tone="neutral" data-size="lg"/)
  })

  // Unlayered rules beat Tailwind's utilities layer whatever their specificity, which would leave the utilities above with no effect.
  test('the stylesheet sits in the components layer, so a utility of src/ui.ts wins over it', async () => {
    const css = await Bun.file(join(LIBRARY, 'src/chat.css')).text()
    const outside = css.replace(/\/\*[\s\S]*?\*\//g, '').trim()

    expect(outside.startsWith('@layer components {')).toBe(true)
    expect(outside.endsWith('}')).toBe(true)
    expect(outside.match(/^\S/gm)?.length).toBe(2)
  })

  test('a part nothing restyles keeps its kai class alone', () => {
    expect(html).toContain('class="kai-chat-disclosure"')
    expect(html).toContain('class="kai-chat-form"')
    expect(html).toContain('class="kai-launcher-body"')
  })

  test('the field and the buttons keep the kayjs-ui classes the theme styles', () => {
    expect(html).toContain('class="kui-field-input"')
    expect(html).toContain('class="kui-icon-btn kai-chat-send size-12"')
  })
})

describe('the chat\'s icons from kayjs-ui\'s settings.icons', () => {
  // The chat the page gives its own @sendIcon and @stopIcon blocks, labelled apart; the markup before it holds the others.
  const split = () => {
    const at = html.indexOf('aria-label="Own icons"')

    return { before: html.slice(0, at), own: html.slice(at, html.indexOf('kai-launcher', at)) }
  }

  test('the send button draws the app\'s send slot, not kayjs-ui\'s arrow', () => {
    const { before } = split()

    expect(before).toContain(body('rocket'))
    expect(html).not.toContain('M12 5v14m6-8l-6-6m-6 6l6-6')
  })

  test('the launcher draws the app\'s chat, close, plus and expand slots, the collapse one showing once it is large', () => {
    const launcher = html.slice(html.indexOf('class="kai-launcher mb-2"'))

    for (const name of ['ghost', 'square-x', 'circle-plus', 'maximize', 'rocket'])
      expect(launcher).toContain(body(name))
  })

  // The stop button shows while a reply streams and the collapse button once the panel is large, so neither is in the server markup: the island carries them.
  test('the browser build carries the app\'s stop and collapse slots', async () => {
    const built = await Bun.build({ entrypoints: [join(LIBRARY, 'src/chat-launcher.kay'), join(LIBRARY, 'src/chat.kay')], target: 'browser', outdir: join(OUT, 'dom'), plugins: [kay({ root: ROOT, target: 'dom', settings: SETTINGS })] })

    expect(built.success, built.logs.join('\n')).toBe(true)

    const code = (await Promise.all(built.outputs.map(async output => output.text()))).join('\n')

    for (const name of ['hand-stop', 'minimize'])
      expect(code).toContain(body(name).match(PATH)![1]!)
  }, 60_000)

  test('an @sendIcon block wins over the setting', () => {
    const { own } = split()

    expect(own).toContain('class="own-send"')
    expect(own).not.toContain(body('rocket'))
  })
})

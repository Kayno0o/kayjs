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
const MARKERS = /<!--[[\]]-->/g

let html = ''

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

  const build = await Bun.build({ entrypoints: [join(ROOT, 'src/entry.ts')], outdir: OUT, target: 'bun', plugins: [kay({ root: ROOT, target: 'ssr' })] })

  if (!build.success)
    throw new AggregateError(build.logs, 'build failed')

  const { Page } = await import(build.outputs[0]!.path) as { Page: (props: Record<string, unknown>) => unknown }

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

  test('a part nothing restyles keeps its kai class alone', () => {
    expect(html).toContain('class="kai-chat-disclosure"')
    expect(html).toContain('class="kai-chat-form"')
    expect(html).toContain('class="kai-launcher-body"')
  })

  test('the field and the buttons keep the kayjs-ui classes the theme styles', () => {
    expect(html).toContain('class="kui-field-input"')
    expect(html).toContain('class="kai-chat-send size-12"')
  })
})

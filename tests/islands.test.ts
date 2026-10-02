import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { generateHydrationScript, renderToString } from '@solidjs/web'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'

plugin(kay())

const fixtures = join(import.meta.dir, 'fixtures/islands')
const HYDRATION_SCRIPT = /<script>([\s\S]*?)<\/script>/

let outdir: string
let pageHtml: string

beforeAll(async () => {
  const { default: Page } = await import(join(fixtures, 'page.kay')) as { default: () => unknown }

  pageHtml = renderToString(() => Page())
  outdir = await mkdtemp(join(tmpdir(), 'kay-islands-'))
  const build = await Bun.build({ entrypoints: [join(fixtures, 'client.ts')], outdir, target: 'browser', splitting: true, plugins: [kay()] })

  if (!build.success)
    throw new AggregateError(build.logs, 'client build failed')

  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  await rm(outdir, { recursive: true, force: true })
})

describe('islands', () => {
  it('server-renders static markup with the interactive component as an island root', () => {
    expect(pageHtml).toContain('<h1>Static title</h1>')
    expect(pageHtml).toContain('<kay-island data-component="tests/fixtures/islands/counter.kay" data-render-id="k')
    expect(pageHtml).toContain('data-props="{&quot;start&quot;:2}"')
    expect(pageHtml).toContain('Count <!--$-->2<!--/-->')
    expect(pageHtml).toContain('<p>after</p>')
  })

  it('hydrates the island in place and keeps it reactive', async () => {
    // The inline hydration script sets up the global the client runtime expects before any island hydrates.
    // Solid's bootstrap assigns `_$HY` on globalThis, which outlives happy-dom's window between test files.
    delete (globalThis as { _$HY?: unknown })._$HY
    // eslint-disable-next-line no-new-func -- runs Solid's own bootstrap script, which happy-dom does not execute from markup
    new Function(HYDRATION_SCRIPT.exec(generateHydrationScript())![1]!)()
    document.body.innerHTML = pageHtml
    const button = document.querySelector('kay-island button')!
    const { ready } = await import(join(outdir, 'client.js')) as { ready: Promise<void> }

    await ready
    expect(document.querySelector('kay-island button')).toBe(button)

    button.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(button.textContent).toBe('Count 3')
  })
})

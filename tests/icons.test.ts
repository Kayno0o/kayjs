import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { iconProps, iconTypes, installedIconSets } from '../src/build/icons'
import { kay } from '../src/build/plugin'
import { check } from '../src/check'
import { pages } from '../src/server'

const FIXTURE = join(import.meta.dir, 'fixtures/icons')
const scratch = await mkdtemp(join(tmpdir(), 'kay-icons-'))
const HOME_PATH = 'M5 12H3l9-9l9 9h-2M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7'

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function bundle(source: string) {
  const entry = join(scratch, `entry-${Bun.hash(source).toString(36)}.ts`)

  await Bun.write(entry, source)

  return Bun.build({ entrypoints: [entry], target: 'browser', plugins: [kay({ root: process.cwd() })], throw: false })
}

describe('icons', () => {
  it('finds the icon sets the project depends on', () => {
    expect([...installedIconSets(FIXTURE).keys()]).toEqual(['tabler'])
    expect(installedIconSets(scratch).size).toBe(0)
  })

  it('renders an imported icon as an svg on the server, an alias as its parent', async () => {
    const app = await pages({ routes: 'tests/fixtures/icons/src/routes', prebuilt: false })
    const html = await (await app.handle(new Request('http://localhost/'))).text()

    expect(html).toContain(`<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" class="icon"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="${HOME_PATH}"/>`)
    expect(html).toContain(`<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">${iconProps(installedIconSets(FIXTURE).get('tabler')!, 'hours-12')!.innerHTML}</svg>`)
  })

  it('bundles only the icons the browser code imports', async () => {
    const result = await bundle('import home from \'~icons/tabler/home\'\nconsole.log(home)\n')
    const code = await result.outputs[0]!.text()

    expect(result.success).toBe(true)
    expect(code).toContain(HOME_PATH)
    expect(code.length).toBeLessThan(2000)
  })

  it('fails the bundle on an icon or a set that is not there, naming it', async () => {
    const misspelt = await bundle('import home from \'~icons/tabler/hom\'\nconsole.log(home)\n')
    const missing = await bundle('import cat from \'~icons/mdi/cat\'\nconsole.log(cat)\n')

    expect(misspelt.success).toBe(false)
    expect(misspelt.logs.map(String).join('\n')).toContain('@iconify-json/tabler has no icon named hom')
    expect(missing.logs.map(String).join('\n')).toContain('~icons/mdi/cat names no installed icon set; add it with `bun add -d @iconify-json/mdi`')
  })

  it('draws an alias with the flips and turns along its chain, and sizes a wide icon to its ratio', async () => {
    const file = join(scratch, 'set.json')

    await Bun.write(file, JSON.stringify({
      prefix: 'demo',
      width: 32,
      height: 16,
      icons: { wide: { body: '<path d="M0 0h32v16"/>' } },
      aliases: { flipped: { parent: 'wide', hFlip: true }, turned: { parent: 'flipped', rotate: 1, hFlip: true }, loop: { parent: 'loop' } },
    }))

    expect(iconProps(file, 'wide')).toEqual({ 'viewBox': '0 0 32 16', 'width': '2em', 'height': '1em', 'aria-hidden': 'true', 'innerHTML': '<path d="M0 0h32v16"/>' })
    expect(iconProps(file, 'flipped')!.innerHTML).toBe('<g transform="translate(32 0) scale(-1 1)"><path d="M0 0h32v16"/></g>')
    expect(iconProps(file, 'turned')!.innerHTML).toBe('<g transform="rotate(90 16 8)"><path d="M0 0h32v16"/></g>')
    expect(iconProps(file, 'loop')).toBeUndefined()
    expect(iconProps(file, 'nothing')).toBeUndefined()
  })

  it('declares each installed icon as a module, so kay check reports a misspelt one', async () => {
    const typo = join(FIXTURE, 'src/routes/typo.kay')

    expect(iconTypes(FIXTURE)).toContain('declare module \'~icons/tabler/home\' {\n  const icon: import(\'kay/icons\').IconProps\n  export default icon\n}\n')
    expect(await check(FIXTURE)).toEqual([])

    try {
      await Bun.write(typo, '---\nimport home from \'~icons/tabler/hom\'\n---\nsvg({...home})\n')

      expect((await check(FIXTURE)).map(diagnostic => [diagnostic.line, diagnostic.code])).toEqual([[2, 'TS2307']])
    }
    finally {
      await rm(typo, { force: true })
    }
  })
})

import type { IconSet } from '../src/runtime/icons'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { iconProps, iconTypes, installedIconSets } from '../src/build/icons'
import { iconSetWarnings, thirdPartyNotices } from '../src/build/licenses'
import { kay } from '../src/build/plugin'
import { check } from '../src/check'
import { iconNames, iconProps as setIconProps } from '../src/runtime/icons'
import { trustHtml } from '../src/runtime/sanitize'
import { pages } from '../src/server'
import { fixtureCopy } from './scratch'

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

  it('draws an icon imported under a capitalised name as a tag, as the svg spreading it', async () => {
    const app = await pages({ routes: 'tests/fixtures/icons/src/routes', prebuilt: false })
    const html = await (await app.handle(new Request('http://localhost/'))).text()

    expect(html).toContain(`<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" data-name="home" class="size-5"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="${HOME_PATH}"/>`)
  })

  it('leaves out an icon only an export the browser code never reads holds', async () => {
    const data = join(scratch, 'icon-data.ts')

    await Bun.write(data, 'import home from \'~icons/tabler/home\'\nimport mail from \'~icons/tabler/mail\'\nexport const USED = [home]\nexport const UNUSED = [mail]\n')

    const result = await bundle(`import { USED } from ${JSON.stringify(data)}\nconsole.log(USED)\n`)
    const code = await result.outputs[0]!.text()

    expect(result.success).toBe(true)
    expect(code).toContain(HOME_PATH)
    expect(code.match(/viewBox/g)).toHaveLength(1)
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

    expect(iconProps(file, 'wide')).toEqual({ 'viewBox': '0 0 32 16', 'width': '2em', 'height': '1em', 'aria-hidden': 'true', 'innerHTML': trustHtml('<path d="M0 0h32v16"/>') })
    expect(String(iconProps(file, 'flipped')!.innerHTML)).toBe('<g transform="translate(32 0) scale(-1 1)"><path d="M0 0h32v16"/></g>')
    expect(String(iconProps(file, 'turned')!.innerHTML)).toBe('<g transform="rotate(90 16 8)"><path d="M0 0h32v16"/></g>')
    expect(setIconProps(await Bun.file(file).json() as IconSet, 'turned')).toEqual(iconProps(file, 'turned'))
    expect(iconProps(file, 'loop')).toBeUndefined()
    expect(iconProps(file, 'nothing')).toBeUndefined()
  })

  it('builds the props of an icon picked at runtime from the set the app imports, as an icon import gives them', async () => {
    const { default: imported } = await import('@iconify-json/tabler/icons.json')
    // The JSON as imported is a set, with no cast.
    const tabler: IconSet = imported
    const file = Bun.resolveSync('@iconify-json/tabler/icons.json', process.cwd())

    expect(setIconProps(tabler, 'home')).toEqual(iconProps(file, 'home'))
    // `123` is an alias of `number-123`.
    expect(setIconProps(tabler, '123')).toEqual(setIconProps(tabler, 'number-123'))
    expect(setIconProps(tabler, 'nothing')).toBeUndefined()
    expect(iconNames(tabler)).toEqual(expect.arrayContaining(['home', '123']))
  })

  it('declares each installed icon as a module, so kay check reports a misspelt one', async () => {
    const copy = await fixtureCopy('icons')

    try {
      expect(iconTypes(copy)).toContain('declare module \'~icons/tabler/home\' {\n  const icon: import(\'kay/icons\').IconProps\n  export default icon\n}\n')
      expect(await check(copy)).toEqual([])

      await Bun.write(join(copy, 'src/routes/typo.kay'), '---\nimport home from \'~icons/tabler/hom\'\n---\nsvg({...home})\n')

      expect((await check(copy)).map(diagnostic => [diagnostic.line, diagnostic.code])).toEqual([[2, 'TS2307']])
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  })

  it('draws an icon held in a record with an svg spreading it, and a component held in a value by its capitalised name', async () => {
    const copy = await fixtureCopy('icons')

    try {
      await Bun.write(join(copy, 'src/chip.kay'), '---\nconst { title } = props<{ title: string }>()\n---\nb.chip {title}\n')
      await Bun.write(join(copy, 'src/routes/chosen.kay'), [
        '---',
        'import type { Component } from \'kay\'',
        'import Chip from \'../chip.kay\'',
        'import Flame from \'~icons/tabler/flame\'',
        'import Home from \'~icons/tabler/home\'',
        '',
        'const ICONS: Record<string, typeof Flame> = { home: Home, flame: Flame }',
        'const VIEWS: Record<string, Component<{ title: string }>> = { chip: Chip }',
        'const key = \'flame\'',
        'const View = VIEWS.chip!',
        '---',
        'svg.size-4({...ICONS[key]})',
        'View(title="Picked")',
        '',
      ].join('\n'))

      expect(await check(copy)).toEqual([])

      const app = await pages({ routes: join(copy, 'src/routes'), prebuilt: false })
      const html = await (await app.handle(new Request('http://localhost/chosen'))).text()

      expect(html).toContain('<svg')
      expect(html).toContain('<b class="chip">Picked</b>')
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  })

  it('warns of a set whose licence asks more than its notice, and credits its author in the notices', async () => {
    const dir = join(scratch, 'attribution')
    const set = join(dir, 'node_modules/@iconify-json/drawn')
    const info = { prefix: 'drawn', name: 'Drawn Icons', author: { name: 'Ada', url: 'https://example.com/drawn' }, license: { title: 'CC BY 4.0', spdx: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' } }

    await Bun.write(join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@iconify-json/drawn': '*' } }))
    await Bun.write(join(set, 'package.json'), JSON.stringify({ name: '@iconify-json/drawn', version: '1.0.0', license: 'CC-BY-4.0' }))
    await Bun.write(join(set, 'icons.json'), JSON.stringify({ prefix: 'drawn', icons: {}, info }))
    await Bun.write(join(set, 'info.json'), JSON.stringify(info))
    // A directory under a licence file's name is no licence file.
    await mkdir(join(set, 'LICENSE'), { recursive: true })
    await Bun.write(join(set, 'LICENSES/CC-BY-4.0.txt'), 'Attribution 4.0 International')

    expect(iconSetWarnings(dir)).toEqual(['kay: Drawn Icons (@iconify-json/drawn) comes under CC BY 4.0, which may ask more than the notice in THIRD-PARTY-LICENSES.txt, such as crediting their author, Ada (https://example.com/drawn) where they show: read https://creativecommons.org/licenses/by/4.0/'])
    expect(thirdPartyNotices([set])).toContain('@iconify-json/drawn 1.0.0 (CC-BY-4.0)\n  Drawn Icons by Ada, https://example.com/drawn, licence at https://creativecommons.org/licenses/by/4.0/')
    expect(thirdPartyNotices([set])).toContain('\n\nAttribution 4.0 International')
    // Tabler's MIT asks nothing past its notice.
    expect(iconSetWarnings(FIXTURE)).toEqual([])
  })

  it('writes the MIT text under the author\'s copyright line for a set whose package ships none', async () => {
    const set = join(scratch, 'mit-set/node_modules/@iconify-json/plain')
    const info = { prefix: 'plain', name: 'Plain Icons', author: { name: 'Ada Lovelace' }, license: { title: 'MIT', spdx: 'MIT' } }

    await Bun.write(join(set, 'package.json'), JSON.stringify({ name: '@iconify-json/plain', version: '1.0.0', license: 'MIT' }))
    await Bun.write(join(set, 'info.json'), JSON.stringify(info))

    const notices = thirdPartyNotices([set])

    expect(notices).toContain('MIT License\n\nCopyright (c) Ada Lovelace\n\nPermission is hereby granted, free of charge')
    expect(notices).not.toContain('it comes under MIT')

    const tabler = thirdPartyNotices([join(import.meta.dir, '../node_modules/@iconify-json/tabler')])

    expect(tabler).toContain('Copyright (c) Paweł Kuna')
    expect(tabler).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
  })

  it('adds Bun\'s notice and the LGPL pointer to an executable\'s notices only', () => {
    expect(thirdPartyNotices([])).not.toContain('oven-sh/webkit')

    const notices = thirdPartyNotices([], { executable: true })

    expect(notices).toContain(`Bun ${Bun.version} (MIT)`)
    expect(notices).toContain('https://github.com/oven-sh/webkit')
    expect(notices).toContain('JavaScriptCore')
  })
})

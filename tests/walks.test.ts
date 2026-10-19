import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { findKayFiles, findProjectFiles, inWalkScope, scoped } from '../src/build/files'
import { bootProblems } from '../src/check/boot'
import { writeShadowTypes } from '../src/check/shadow-types'
import { scratchDir } from './scratch'

const names = (root: string, files: string[]) => files.map(file => file.slice(root.length + 1))

describe('walk scope', () => {
  it('walks a tree once per scope for any names, and finds a file added or removed once the next scope starts', async () => {
    const root = await scratchDir('walks-')

    await Promise.all([Bun.write(join(root, 'src/a.kay'), 'p a\n'), Bun.write(join(root, 'src/b.css'), '')])

    const [kay, css] = await inWalkScope(async () => {
      const first = [await findKayFiles(root, { project: true }), await findProjectFiles(root, /\.css$/, { project: true })] as const

      await Bun.write(join(root, 'src/c.kay'), 'p c\n')
      await rm(join(root, 'src/b.css'))

      // Still the walk the scope began with, whatever the names asked for.
      expect(names(root, await findKayFiles(root, { project: true }))).toEqual(names(root, first[0]))
      expect(names(root, await findProjectFiles(root, /\.css$/, { project: true }))).toEqual(['src/b.css'])

      return first
    })

    expect(names(root, kay)).toEqual(['src/a.kay'])
    expect(names(root, css)).toEqual(['src/b.css'])
    expect(names(root, await inWalkScope(async () => findKayFiles(root, { project: true })))).toEqual(['src/a.kay', 'src/c.kay'])
    expect(await inWalkScope(async () => findProjectFiles(root, /\.css$/, { project: true }))).toEqual([])
    // Outside a scope every call looks again.
    await Bun.write(join(root, 'src/d.kay'), 'p d\n')
    expect(names(root, await findKayFiles(root, { project: true }))).toEqual(['src/a.kay', 'src/c.kay', 'src/d.kay'])
  })

  it('keeps the walks of different options apart, and what scoped computes once per scope', async () => {
    const root = await scratchDir('walks-')

    await Promise.all([Bun.write(join(root, 'src/a.kay'), 'p a\n'), Bun.write(join(root, 'other/package.json'), '{}\n'), Bun.write(join(root, 'other/b.kay'), 'p b\n')])

    await inWalkScope(async () => {
      expect(names(root, await findKayFiles(root, { project: true }))).toEqual(['other/b.kay', 'src/a.kay'])
      expect(names(root, await findKayFiles(root, { project: true, ownKayOnly: true }))).toEqual(['src/a.kay'])

      let runs = 0

      expect([scoped('n', () => ++runs), scoped('n', () => ++runs)]).toEqual([1, 1])
    })

    let runs = 0

    expect([scoped('n', () => ++runs), scoped('n', () => ++runs)]).toEqual([1, 2])
  })

  it('writes the shadow tree of the files there are at each call, and of the scope\'s walk inside one', async () => {
    const root = await scratchDir('walks-shadow-')

    await Bun.write(join(root, 'src/routes/index.kay'), 'h1 Home\n')

    expect([...(await writeShadowTypes(root)).files.keys()].length).toBe(1)
    await Bun.write(join(root, 'src/routes/about.kay'), 'h1 About\n')
    expect([...(await writeShadowTypes(root)).files.keys()].length).toBe(2)

    await inWalkScope(async () => {
      await writeShadowTypes(root)
      await Bun.write(join(root, 'src/routes/contact.kay'), 'h1 Contact\n')
      expect([...(await writeShadowTypes(root)).files.keys()].length).toBe(2)
    })

    expect([...(await writeShadowTypes(root)).files.keys()].length).toBe(3)
  })
})

describe('boot problems of a scanned project', () => {
  it('report what the boot alone finds, public clashes and a misshapen endpoint file included', async () => {
    const root = await scratchDir('walks-boot-')

    await Promise.all([
      Bun.write(join(root, 'src/routes/index.kay'), 'h1 Home\n'),
      Bun.write(join(root, 'src/routes/about.kay'), 'h1 About\n'),
      Bun.write(join(root, 'public/about'), ''),
      Bun.write(join(root, 'public/_kay/env.js'), ''),
    ])

    const options = { publicEnv: {} as never }
    const feeds = [{ collection: 'posts', path: '/rss.xml', localized: false }]
    const clashing = await bootProblems(root, options, feeds, (await writeShadowTypes(root, options)).served)

    expect(clashing.length).toBeGreaterThan(0)
    expect(clashing).toEqual(await bootProblems(root, options, feeds))

    await Bun.write(join(root, 'src/routes/[...rest].json.ts'), 'export const GET = () => 1\n')

    const refused = await bootProblems(root, options, feeds, (await writeShadowTypes(root, options)).served)

    expect(refused.some(problem => problem.message.includes('plain [name] segment'))).toBe(true)
    expect(refused).toEqual(await bootProblems(root, options, feeds))
  })
})

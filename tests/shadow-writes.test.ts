import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { writeShadowTypes } from '../src/check'
import { scratchDir } from './scratch'

// The modification time of every file under `dir`.
async function stamps(dir: string): Promise<Map<string, number>> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())

  return new Map(await Promise.all(files.map(async entry => [join(entry.parentPath, entry.name), (await stat(join(entry.parentPath, entry.name))).mtimeMs] as const)))
}

describe('writing the shadow tree again', () => {
  it('rewrites the one shadow whose .kay file changed', async () => {
    const root = await scratchDir('shadow-writes-')

    await Promise.all([
      Bun.write(join(root, 'tsconfig.json'), '{}\n'),
      Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n'),
      Bun.write(join(root, 'src/routes/about.kay'), 'p About\n'),
      Bun.write(join(root, 'src/routes/blog/post.kay'), 'p Post\n'),
    ])
    await writeShadowTypes(root)
    await Bun.sleep(20)

    const types = join(root, '.kay/types')
    const before = await stamps(types)

    await Bun.write(join(root, 'src/routes/about.kay'), 'p About us\n')
    await writeShadowTypes(root)

    const after = await stamps(types)
    const rewritten = [...after].filter(([file, time]) => before.get(file) !== time).map(([file]) => file.slice(types.length + 1))

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    expect(rewritten).toEqual(['src/routes/about.kay.tsx'])
  })

  it('leaves out what only `kay check` reports when asked for the types alone, and makes it again, whole, for a check', async () => {
    const root = await scratchDir('shadow-types-only-')
    const page = join(root, 'src/routes/index.kay')

    await Promise.all([
      Bun.write(join(root, 'tsconfig.json'), '{}\n'),
      Bun.write(page, '---\nconst width = window.innerWidth\n---\np {width}\n'),
    ])

    const codes = (diagnostics: { code?: string | undefined }[]) => diagnostics.map(({ code }) => code)
    const quick = await writeShadowTypes(root, { typesOnly: true })
    const types = await Bun.file(join(root, '.kay/types/src/routes/index.kay.tsx')).text()

    expect(codes(quick.diagnostics)).not.toContain('browser-only-read')

    const whole = await writeShadowTypes(root)

    expect(codes(whole.diagnostics)).toContain('browser-only-read')
    expect(await Bun.file(join(root, '.kay/types/src/routes/index.kay.tsx')).text()).toBe(types)
  })

  it('runs no project check for the types alone, and every one for a check', async () => {
    const root = await scratchDir('shadow-types-only-checks-')

    await Promise.all([
      Bun.write(join(root, 'tsconfig.json'), '{}\n'),
      Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n'),
    ])

    const options = { redirects: { '/old': '/nowhere' } }

    expect((await writeShadowTypes(root, { ...options, typesOnly: true })).problems).toEqual([])
    expect((await writeShadowTypes(root, options)).problems.length).toBeGreaterThan(0)
  })

  it('answers an unchanged component from memory, and compiles it again once its source changes', async () => {
    const root = await scratchDir('shadow-memory-')
    const page = join(root, 'src/routes/index.kay')

    await Promise.all([Bun.write(join(root, 'tsconfig.json'), '{}\n'), Bun.write(page, 'p Home\n')])
    await writeShadowTypes(root)
    await rm(join(root, '.kay/cache'), { recursive: true, force: true })
    await writeShadowTypes(root)

    // A component read from the cache entry again would be written back, which the memory spares.
    expect(existsSync(join(root, '.kay/cache'))).toBe(false)
    await Bun.write(page, 'p Home again\n')
    await writeShadowTypes(root)
    expect(await Bun.file(join(root, '.kay/types/src/routes/index.kay.tsx')).text()).toContain('Home again')
  })
})

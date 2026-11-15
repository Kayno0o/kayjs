import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { ttlNames } from '../src/check/ttl-names'
import { scratchDir } from './scratch'

async function fixed(files: Record<string, string>): Promise<{ text: Record<string, string>, found: Awaited<ReturnType<typeof ttlNames>> }> {
  const root = await scratchDir('ttl-names-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await ttlNames(root, {})

    await applySafeFixes(root, found)

    return { found, text: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-ttl-names', () => {
  it('renames maxAge to ttl on signed.sign, files.url and the protect bags', async () => {
    const { found, text } = await fixed({
      'src/a.ts': 'import { action } from \'kay\'\nimport { files, signed } from \'kay/server\'\n\nsigned.sign(\'a\', \'b\', { maxAge: \'1h\' })\nfiles.url(\'private/x.png\', { maxAge: \'1d\' })\nexport const send = action(() => 1, { protect: { minTime: { after: \'3s\', maxAge: \'1h\' }, proofOfWork: { maxAge } } })\n',
    })

    expect(found).toHaveLength(4)
    expect(text['src/a.ts']).toBe('import { action } from \'kay\'\nimport { files, signed } from \'kay/server\'\n\nsigned.sign(\'a\', \'b\', { ttl: \'1h\' })\nfiles.url(\'private/x.png\', { ttl: \'1d\' })\nexport const send = action(() => 1, { protect: { minTime: { after: \'3s\', ttl: \'1h\' }, proofOfWork: { ttl: maxAge } } })\n')
  })

  it('renames maxAge on workChallenge, kayjs-auth\'s proofOfWork and the mail data a template reads', async () => {
    const { found, text } = await fixed({
      'src/a.ts': 'import { workChallenge } from \'kay/server\'\nimport { proofOfWork } from \'@kayjs/auth\'\n\nexport const a = workChallenge(\'contact\', { difficulty: 5, maxAge: \'1h\' })\nexport const b = proofOfWork({ maxAge: \'10m\' })\nexport const c = (data: { maxAge?: { link?: string } }) => `${data.maxAge.link} ${data.maxAge?.code}`\n',
      'src/b.ts': 'import { proofOfWork } from \'./mine\'\n\nexport const a = proofOfWork({ maxAge: \'10m\' })\nexport const c = (data: { maxAge: { link: string } }) => data.maxAge.link\n',
    })

    expect(found).toHaveLength(4)
    expect(text['src/a.ts']).toBe('import { workChallenge } from \'kay/server\'\nimport { proofOfWork } from \'@kayjs/auth\'\n\nexport const a = workChallenge(\'contact\', { difficulty: 5, ttl: \'1h\' })\nexport const b = proofOfWork({ ttl: \'10m\' })\nexport const c = (data: { maxAge?: { link?: string } }) => `${data.ttl.link} ${data.ttl?.code}`\n')
    expect(text['src/b.ts']).toContain('maxAge')
  })

  it('leaves the HTTP and cookie maxAge, other receivers and a ttl alone, and reports a clash with no fix', async () => {
    const { found, text } = await fixed({
      'src/a.ts': 'import { signed } from \'kay/server\'\n\nsigned.sign(\'a\', \'b\', { ttl: \'1h\' })\nother.url(\'x\', { maxAge: 1 })\nctx.cookies.set(\'a\', \'b\', { maxAge: 60 })\nexport const cors = { origins: [], maxAge: \'1h\' }\nexport const other = { protect: { minTime: { maxAge: 1 } } }\nexport const again = { minTime: { maxAge: 1 }, proofOfWork: { maxAge: 1 } }\n',
      'src/b.ts': 'import { signed } from \'kay/server\'\n\nsigned.sign(\'a\', \'b\', { ttl: \'1h\', maxAge: \'2h\' })\n',
    })

    expect(found).toHaveLength(1)
    expect(found[0]?.fixes).toBeUndefined()
    expect(text['src/a.ts']).toContain('maxAge: 60')
    expect(text['src/b.ts']).toContain('maxAge: \'2h\'')
  })
})

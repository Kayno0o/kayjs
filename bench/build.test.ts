import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { weighOutput } from './build'

const dir = mkdtempSync(join(tmpdir(), 'bench-build-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('weighOutput', () => {
  it('counts the deployed files raw and gzip, leaving out maps, precompressed copies and what is ignored', () => {
    const body = 'a'.repeat(1000)

    mkdirSync(join(dir, 'out', 'cache'), { recursive: true })
    mkdirSync(join(dir, 'other'))
    writeFileSync(join(dir, 'out', 'app.js'), body)
    writeFileSync(join(dir, 'out', 'app.js.map'), body)
    writeFileSync(join(dir, 'out', 'app.js.br'), body)
    writeFileSync(join(dir, 'out', 'app.js.gz'), body)
    writeFileSync(join(dir, 'out', 'cache', 'big.bin'), body)
    writeFileSync(join(dir, 'other', 'page.html'), body)

    const weight = weighOutput(dir, ['out', 'other'], /^out\/cache/)

    expect(weight).toEqual({ raw: 2000, gzip: Bun.gzipSync(body).length * 2, files: 2 })
  })
})

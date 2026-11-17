import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { fixtureCopy } from './scratch'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

// Text only the browser's `validate` holds.
const VALIDATOR = 'Expected required property'

it('keeps the validator in a chunk of its own that no island and no entry loads up front, the first call to validate loading it', async () => {
  const root = resolve(await fixtureCopy('island-validate'))

  dirs.push(root)
  const client = await buildClient(root)
  const read = async (url: string) => Bun.file(join(client.dir, url.slice('/_kay/'.length))).text()
  const up = [client.entry, ...client.entryImports, ...Object.values(client.islands).flat()].filter((url): url is string => url !== undefined)
  const chunks = await Array.fromAsync(new Bun.Glob('*.js').scan(client.dir))
  const holding = (await Promise.all(chunks.map(async chunk => [chunk, await Bun.file(join(client.dir, chunk)).text()] as const))).filter(([, code]) => code.includes(VALIDATOR))

  expect(Object.keys(client.islands).sort()).toEqual(['src/components/checker.kay', 'src/components/plain.kay'])
  expect(holding.map(([name]) => name)).toEqual([expect.stringMatching(/^validate-run/)])
  expect((await Promise.all(up.map(read))).filter(code => code.includes(VALIDATOR))).toEqual([])
}, 120_000)

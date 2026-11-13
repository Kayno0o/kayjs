import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { fixtureCopy } from './scratch'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

// A header only the code that posts a call writes.
const POSTING = 'idempotency-key'

it('keeps the code that posts an action call out of every file an island loads up front, in a chunk of its own the first call loads', async () => {
  const root = resolve(await fixtureCopy('action-streams'))

  dirs.push(root)
  const client = await buildClient(root)
  const text = async (url: string) => Bun.file(join(client.dir, url.slice('/_kay/'.length))).text()
  const up = [client.entry, ...Object.values(client.islands).flat()].filter((url): url is string => url !== undefined)
  const chunks = await Array.fromAsync(new Bun.Glob('*.js').scan(client.dir))
  const holding = (await Promise.all(chunks.map(async chunk => [chunk, await Bun.file(join(client.dir, chunk)).text()] as const))).filter(([, code]) => code.includes(POSTING))

  expect(Object.keys(client.islands).length).toBeGreaterThan(0)
  // The page swap's own entry carries its copy for forms, so a chunk of the island build and that one are the two.
  expect(holding.map(([name]) => name).filter(name => !name.startsWith('nav-'))).toEqual([expect.stringMatching(/^action-post-/)])
  expect((await Promise.all(up.map(text))).filter(code => code.includes(POSTING))).toEqual([])
}, 120_000)

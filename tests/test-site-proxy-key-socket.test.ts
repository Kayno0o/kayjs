import { resolve } from 'node:path'
import { expect, it } from 'bun:test'
import { testSite } from '../src/test'

const HEADER = 'x-upstream-key'
const root = resolve(import.meta.dir, 'fixtures/ws-body')
const { default: rooms } = await import(resolve(root, 'src/api/rooms.ts')) as typeof import('./fixtures/ws-body/src/api/rooms')
const site = await testSite({ root, proxy: { key: HEADER }, proxyKey: 'secret-key' })

it('sends the key with a socket upgrade, and a test can send none', async () => {
  const socket = site.socket(rooms, '/')

  socket.send({ type: 'say', text: 'hi' })
  expect(await socket.next()).toMatchObject({ type: 'echo' })
  expect((await site.socketRefusal(rooms, '/', { headers: { [HEADER]: '' } })).status).toBe(403)
})

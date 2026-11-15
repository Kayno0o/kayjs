import { expect, test } from 'bun:test'
import { acceptsFile } from '../src/accept'
import { takeFiles } from '../src/file-limits'

const file = (name: string, size: number, type = 'image/png') => new File([new Uint8Array(size)], name, { type })
const images = (candidate: File) => acceptsFile('image/*', candidate)

test('splits the files into the ones that fit and the ones left out, one list per reason', () => {
  const ok = file('a.png', 10)
  const { taken, rejected } = takeFiles([ok, file('b.png', 10), file('c.txt', 1, 'text/plain'), file('big.png', 500), file('d.png', 10)], { accepts: images, maxBytes: 100, room: 2 })

  expect(taken).toHaveLength(2)
  expect(taken[0]).toBe(ok)
  expect(rejected.map(item => [item.reason, item.files.map(left => left.name)])).toEqual([['type', ['c.txt']], ['size', ['big.png']], ['count', ['d.png']]])
})

test('a file already kept is not taken twice, and no room takes none', () => {
  const kept = file('a.png', 10)
  const again = new File([new Uint8Array(10)], 'a.png', { type: 'image/png', lastModified: kept.lastModified })

  expect(takeFiles([again], { accepts: images, maxBytes: Number.POSITIVE_INFINITY, room: 3, kept: [kept] })).toEqual({ taken: [], rejected: [] })
  expect(takeFiles([file('b.png', 1)], { accepts: images, maxBytes: 10, room: -1 }).rejected.map(item => item.reason)).toEqual(['count'])
})

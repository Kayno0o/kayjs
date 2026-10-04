import type { CpuProfile } from './attribution'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { APP, BUNDLER, bytesByOrigin, ENGINE, GC, gzipSize, KAY, originOf, piecesOf, SOLID, sourceAt, timeByOrigin } from './attribution'

const REPO = join(import.meta.dir, '..')
const MAP_FILE = join(REPO, 'bench/apps/kay/.kay/client/dist/entry.js.map')
// `abc` from solid-js and `def` from kay on the first line; on the second, `g` before any segment and `h` from solid-js.
const MAP = { sources: ['../../../../../../node_modules/solid-js/dist/solid.js', '../../../../../../src/runtime/client.ts'], mappings: 'AAAA,GCAA;CDAA' }

function frame(url: string, functionName = 'f', scriptId = '1') {
  return { functionName, url, scriptId, lineNumber: 0, columnNumber: 0 }
}

describe('originOf', () => {
  it.each([
    ['node_modules/solid-js/dist/solid.js', SOLID],
    ['node_modules/@solidjs/web/dist/server.js', SOLID],
    ['node_modules/.bun/seroval@1.6.7/node_modules/seroval/dist/index.js', SOLID],
    ['node_modules/devalue/src/stringify.js', 'devalue'],
    ['node_modules/@sinclair/typebox/build/index.mjs', '@sinclair/typebox'],
    ['node_modules/kay/src/runtime/client.ts', KAY],
    ['src/runtime/client.ts', KAY],
    ['bench/apps/kay/.kay/client/entry.ts', KAY],
    ['bench/apps/kay/components/table.kay', APP],
    ['bench/shared/data.ts', APP],
  ])('reads %s as %s', (path, origin) => {
    expect(originOf(join(REPO, path))).toBe(origin)
  })

  it('reads a file URL as its path', () => {
    expect(originOf(`file://${join(REPO, 'src/server/render.ts')}`)).toBe(KAY)
  })
})

describe('piecesOf', () => {
  it('splits a bundle at its segments, the text no segment covers and the source map comment left to the bundler', () => {
    expect(piecesOf('abcdef\ngh\n//# sourceMappingURL=entry.js.map\n', MAP, MAP_FILE)).toEqual([
      { origin: SOLID, text: 'abc' },
      { origin: KAY, text: 'def' },
      { origin: BUNDLER, text: '\n' },
      { origin: BUNDLER, text: 'g' },
      { origin: SOLID, text: 'h' },
    ])
  })
})

describe('bytesByOrigin', () => {
  it('adds raw bytes up across files and counts what dropping an origin saves once gzipped', () => {
    const solid = 'function signal(value){return [()=>value,next=>{value=next}]}'.repeat(20)
    const files = [[{ origin: SOLID, text: solid }, { origin: KAY, text: 'hydrate()' }], [{ origin: SOLID, text: 'é' }]]
    const bytes = bytesByOrigin(files)

    expect(bytes.get(SOLID)!.raw).toBe(solid.length + 2)
    expect(bytes.get(KAY)!.raw).toBe(9)
    expect(bytes.get(SOLID)!.gzipSaved).toBe(gzipSize(`${solid}hydrate()`) - gzipSize('hydrate()') + gzipSize('é') - gzipSize(''))
  })
})

describe('timeByOrigin', () => {
  it('counts each sample until the next for its frame, a native one for its caller, idle for nobody', () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame('', '(root)', '0'), children: [2, 4, 5] },
        { id: 2, callFrame: frame(join(REPO, 'node_modules/solid-js/dist/solid.js')), children: [3] },
        { id: 3, callFrame: frame('', 'cloneNode', '0') },
        { id: 4, callFrame: frame('', '(garbage collector)', '0') },
        { id: 5, callFrame: frame('', '(idle)', '0') },
      ],
      samples: [3, 2, 4, 5, 1],
      timeDeltas: [0, 10, 20, 30, 40],
    }

    expect(timeByOrigin(profile, ({ url }) => url === '' ? undefined : originOf(url))).toEqual(new Map([[SOLID, 30], [GC, 30], [ENGINE, 0]]))
  })
})

describe('sourceAt', () => {
  it('maps a position to the last segment at or before it', () => {
    const segments = [[[0, 0, 0, 0], [3, 1, 0, 0]], [[1, 0, 0, 0]]]

    expect(sourceAt(MAP, segments, 0, 2)).toBe(MAP.sources[0])
    expect(sourceAt(MAP, segments, 0, 3)).toBe(MAP.sources[1])
    expect(sourceAt(MAP, segments, 1, 0)).toBeUndefined()
  })
})

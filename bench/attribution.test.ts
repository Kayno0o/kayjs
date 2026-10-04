import type { CpuProfile } from './attribution'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { APP, browserOrigin, BUNDLER, bytesByOrigin, ENGINE, GC, gzipSize, INLINE, KAY, LAYOUT, originOf, readChunk, timeByOrigin } from './attribution'

const REPO = join(import.meta.dir, '..')
const DEVALUE = 'devalue'
const MAP_FILE = join(REPO, 'bench/apps/kay/.kay/client/dist/entry.js.map')
// `abc` from devalue and `déf` from kay on the first line; on the second, `g` before any segment and `h` from devalue.
const MAP = { sources: ['../../../../../../node_modules/devalue/src/parse.js', '../../../../../../src/runtime/client.ts'], mappings: 'AAAA,GCAA;CDAA' }

const CODE = 'abcdéf\ngh\n//# debugId=E11AD20C\n//# sourceMappingURL=entry.js.map\n'

function frame(url: string, functionName = 'f', scriptId = '1', lineNumber = 0, columnNumber = 0) {
  return { functionName, url, scriptId, lineNumber, columnNumber }
}

describe('originOf', () => {
  it.each([
    ['node_modules/.bun/seroval@1.6.7/node_modules/seroval/dist/index.js', 'seroval'],
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

  it('reads a path that is not a file as other', () => {
    expect(originOf('node:stream')).toBe('other')
  })
})

describe('readChunk', () => {
  it('splits a bundle at its segments in UTF-16 columns, the text no segment covers to the bundler and the source map comments left out', () => {
    const { pieces } = readChunk(CODE, MAP, MAP_FILE)

    expect(pieces).toEqual([
      { origin: DEVALUE, text: 'abc' },
      { origin: KAY, text: 'déf' },
      { origin: BUNDLER, text: '\n' },
      { origin: BUNDLER, text: 'g' },
      { origin: DEVALUE, text: 'h' },
    ])
    expect(bytesByOrigin([pieces]).get(KAY)!.raw).toBe(4)
  })
})

describe('bytesByOrigin', () => {
  it('adds raw bytes up across files and counts what dropping an origin saves once gzipped', () => {
    const library = 'function signal(value){return [()=>value,next=>{value=next}]}'.repeat(20)
    const files = [[{ origin: DEVALUE, text: library }, { origin: KAY, text: 'hydrate()' }], [{ origin: DEVALUE, text: 'é' }]]
    const bytes = bytesByOrigin(files)

    expect(bytes.get(DEVALUE)!.raw).toBe(library.length + 2)
    expect(bytes.get(KAY)!.raw).toBe(9)
    expect(bytes.get(DEVALUE)!.gzipSaved).toBe(gzipSize(`${library}hydrate()`) - gzipSize('hydrate()') + gzipSize('é') - gzipSize(''))
  })
})

describe('timeByOrigin', () => {
  it('counts each sample until the next for its frame, a native one for its caller, idle for nobody', () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame('', '(root)', '0'), children: [2, 4, 5] },
        { id: 2, callFrame: frame(join(REPO, 'node_modules/devalue/src/parse.js')), children: [3] },
        { id: 3, callFrame: frame('', 'cloneNode', '0') },
        { id: 4, callFrame: frame('', '(garbage collector)', '0') },
        { id: 5, callFrame: frame('', '(idle)', '0') },
      ],
      samples: [3, 2, 4, 5, 1],
      timeDeltas: [0, 10, 20, 30, 40],
    }

    expect(timeByOrigin(profile, ({ url }) => url === '' ? undefined : originOf(url))).toEqual(new Map([[DEVALUE, 30], [GC, 30], [ENGINE, 0]]))
  })
})

describe('browserOrigin', () => {
  const originOfFrame = browserOrigin(new Map([['entry.js', readChunk(CODE, MAP, MAP_FILE)]]))

  it('leaves a native function to its caller and gives Playwright\'s evaluations the layout they force', () => {
    expect(originOfFrame(frame('', 'cloneNode', '0'))).toBeUndefined()
    expect(originOfFrame(frame('', '', '7'))).toBe(LAYOUT)
  })

  it('reads a function in a chunk by where its first character comes from', () => {
    expect(originOfFrame(frame('http://localhost/_kay/entry.js', 'f', '5', 0, 1))).toBe(DEVALUE)
    expect(originOfFrame(frame('http://localhost/_kay/entry.js', 'f', '5', 0, 4))).toBe(KAY)
    expect(originOfFrame(frame('http://localhost/_kay/entry.js', 'f', '5', 1, 0))).toBe(BUNDLER)
    expect(originOfFrame(frame('http://localhost/_kay/entry.js', 'f', '5', 9, 0))).toBe(BUNDLER)
  })

  it('reads a script outside the build as one of the page\'s inline scripts', () => {
    expect(originOfFrame(frame('http://localhost/table'))).toBe(INLINE)
  })
})

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeBundleMappings } from '../build/sourcemap'

interface LoadedMap {
  sources: string[]
  lines: number[][][]
}

// Frames read in a stack: a URL with its line and column, in Chrome's `at fn (url:1:2)` and Firefox's and Safari's `fn@url:1:2` alike.
const FRAME = /(https?:\/\/[^\s()]+?):(\d+):(\d+)(?=\)?$)/
const CHUNK_NAME = /^[\w.-]+\.js$/
// A report holds at most this many lines to map, and the server keeps this many maps decoded.
const MAX_FRAMES = 60
const MAX_LOADED = 32
// A line this long is no frame of a real stack, and the pattern reading it backtracks.
const MAX_LINE = 1000

// Maps the frames of a browser's stack to `.kay` lines with the source maps `kay build` kept in `dir`, never served; a frame no map covers stays as it was.
export function browserStackMapper(dir: string): (stack: string) => Promise<string> {
  let names: Promise<Set<string>> | undefined
  const loaded = new Map<string, Promise<LoadedMap | undefined>>()

  async function load(name: string): Promise<LoadedMap | undefined> {
    names ??= listed(dir)

    if (!CHUNK_NAME.test(name) || !(await names).has(`${name}.map`))
      return undefined

    let map = loaded.get(name)

    // Read again, a map used last stays.
    if (map) {
      loaded.delete(name)
    }
    else {
      if (loaded.size >= MAX_LOADED)
        loaded.delete(loaded.keys().next().value!)

      map = read(join(dir, `${name}.map`))
    }

    loaded.set(name, map)

    return map
  }

  return async (stack) => {
    const lines = stack.split('\n')

    for (const [at, text] of lines.slice(0, MAX_FRAMES).entries()) {
      const frame = text.length > MAX_LINE ? null : FRAME.exec(text)

      if (!frame)
        continue

      const map = await load(chunkOf(frame[1]!))
      const mapped = map && lookup(map, Number(frame[2]), Number(frame[3]))

      if (mapped !== undefined)
        lines[at] = `${text.slice(0, frame.index)}${mapped}${text.slice(frame.index + frame[0].length)}`
    }

    return lines.join('\n')
  }
}

async function listed(dir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(dir))
  }
  catch {
    return new Set()
  }
}

function chunkOf(url: string): string {
  return URL.parse(url)?.pathname.split('/').pop() ?? ''
}

async function read(file: string): Promise<LoadedMap | undefined> {
  try {
    const { sources, mappings } = await Bun.file(file).json() as { sources: string[], mappings: string }

    return { sources, lines: decodeBundleMappings(mappings) }
  }
  catch {
    return undefined
  }
}

// The nearest segment at or before the column, on its line, with a source.
function lookup(map: LoadedMap, line: number, column: number): string | undefined {
  const segments = map.lines[line - 1]
  let found: number[] | undefined

  for (const segment of segments ?? []) {
    if (segment[0]! > column - 1)
      break

    found = segment
  }

  const source = found !== undefined && found.length > 3 ? map.sources[found[1]!] : undefined

  return source === undefined || found === undefined ? undefined : `${source}:${found[2]! + 1}:${found[3]! + 1}`
}

import type { ContextKeys } from './reach'
import { realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { kayLog } from '../runtime/log'

// What the reach walk met, as `kay build` records it so a server started from disk walks the routes' imports and reads no template, with no compiler loaded.
export interface ContextReads {
  // The keys of `ctx` each template reads, false for one reading none.
  keys: Map<string, ContextKeys | false>
  // The files each module imports that the walk follows, `import.meta.glob` matches and aliases included, in the order the walk meets them.
  edges: Map<string, string[]>
  // Whether this is the build's answer, read in place of the templates; else a scan adds each answer it works out.
  recorded: boolean
}

export const CONTEXT_RECORD = 'context-reads.json'

function real(path: string): string {
  try {
    return realpathSync(path)
  }
  catch {
    return resolve(path)
  }
}

// Written as paths from the root, which a build moved to another directory keeps.
export async function writeContextRecord(output: string, root: string, reads: ContextReads): Promise<void> {
  const base = real(root)
  const sorted = <Value>(map: Map<string, Value>, value: (found: Value) => unknown) => Object.fromEntries([...map].map(([file, found]) => [relative(base, file), value(found)] as const).sort(([a], [b]) => a.localeCompare(b)))
  const named = new Map([...reads.keys].filter((entry): entry is [string, ContextKeys] => entry[1] !== false))

  await Bun.write(join(output, CONTEXT_RECORD), JSON.stringify({ reads: sorted(reads.keys, found => found !== false), keys: sorted(named, keys => keys === 'all' ? keys : keys.toSorted()), edges: sorted(reads.edges, paths => paths.map(path => relative(base, path))) }))
}

// Undefined for a build that wrote none, which a scan then answers from the templates.
export async function readContextRecord(output: string, root: string): Promise<ContextReads | undefined> {
  const file = Bun.file(join(output, CONTEXT_RECORD))

  if (!await file.exists())
    return undefined

  try {
    const base = real(root)
    const { reads, keys, edges } = await file.json() as { reads: Record<string, boolean>, keys: Record<string, ContextKeys>, edges: Record<string, string[]> }

    return {
      keys: new Map(Object.entries(reads).map(([path, read]) => [resolve(base, path), read ? keys[path] ?? 'all' : false] as const)),
      edges: new Map(Object.entries(edges).map(([path, found]) => [resolve(base, path), found.map(other => resolve(base, other))] as const)),
      recorded: true,
    }
  }
  catch {
    kayLog('warn', `${CONTEXT_RECORD} in ${output} is unreadable, so the templates are read instead; run kay build again`)

    return undefined
  }
}

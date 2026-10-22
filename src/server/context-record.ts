import { realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { kayLog } from '../runtime/log'

// Whether each file the reach walk met reads `ctx`, as `kay build` records them so a server started from disk never loads the compiler to find them again.
export interface ContextReads {
  files: Map<string, boolean>
  // The files the `import.meta.glob` calls of each module expand to, which the walk follows, so reading them needs no Babel either.
  globs: Map<string, string[]>
  // Whether `files` is the build's answer, read in place of the templates; else a scan adds each answer it works out.
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

  await Bun.write(join(output, CONTEXT_RECORD), JSON.stringify({ reads: sorted(reads.files, found => found), globs: sorted(reads.globs, paths => paths.map(path => relative(base, path)).sort()) }))
}

// Undefined for a build that wrote none, which a scan then answers from the templates.
export async function readContextRecord(output: string, root: string): Promise<ContextReads | undefined> {
  const file = Bun.file(join(output, CONTEXT_RECORD))

  if (!await file.exists())
    return undefined

  try {
    const base = real(root)
    const { reads, globs } = await file.json() as { reads: Record<string, boolean>, globs: Record<string, string[]> }

    return { files: new Map(Object.entries(reads).map(([path, found]) => [resolve(base, path), found] as const)), globs: new Map(Object.entries(globs).map(([path, found]) => [resolve(base, path), found.map(other => resolve(base, other))] as const)), recorded: true }
  }
  catch {
    kayLog('warn', `${CONTEXT_RECORD} in ${output} is unreadable, so the templates are read instead; run kay build again`)

    return undefined
  }
}

import { realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { kayLog } from '../runtime/log'

// Whether each file the reach walk met reads `ctx`, as `kay build` records them so a server started from disk never loads the compiler to find them again.
export interface ContextReads {
  files: Map<string, boolean>
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
export async function writeContextRecord(output: string, root: string, files: Map<string, boolean>): Promise<void> {
  const base = real(root)

  await Bun.write(join(output, CONTEXT_RECORD), JSON.stringify(Object.fromEntries([...files].map(([file, found]) => [relative(base, file), found] as const).sort(([a], [b]) => a.localeCompare(b)))))
}

// Undefined for a build that wrote none, which a scan then answers from the templates.
export async function readContextRecord(output: string, root: string): Promise<ContextReads | undefined> {
  const file = Bun.file(join(output, CONTEXT_RECORD))

  if (!await file.exists())
    return undefined

  try {
    const base = real(root)
    const paths = await file.json() as Record<string, boolean>

    return { files: new Map(Object.entries(paths).map(([path, found]) => [resolve(base, path), found] as const)), recorded: true }
  }
  catch {
    kayLog('warn', `${CONTEXT_RECORD} in ${output} is unreadable, so the templates are read instead; run kay build again`)

    return undefined
  }
}

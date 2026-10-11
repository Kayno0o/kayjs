import type { Guard } from 'kay'
import type { FileSaver } from './files'
import { workingTree } from './files'

export interface CmsOptions {
  // Where the collection screens live, `/admin` by default.
  prefix?: string | undefined
  // Who may use the screens and the API outside edit mode, such as kayjs-auth's `auth.guard({ require: 'editor' })`. Without one, only an edit-mode request gets through.
  guard?: Guard | undefined
  // Where a folder entry's file goes: `forgejo(...)` on a deployed site, the working tree by default, for `kay dev`.
  files?: FileSaver | undefined
}

export interface CmsSettings {
  prefix: string
  guard: Guard | undefined
  files: FileSaver
}

let current: CmsSettings | undefined

export function configure({ prefix = '/admin', guard, files = workingTree() }: CmsOptions): CmsSettings {
  current = { prefix: prefix.replace(/\/+$/, '') || '/', guard, files }

  return current
}

// What `cms()` in kay.config.ts was given.
export function settings(): CmsSettings {
  if (!current)
    throw new Error('kayjs-cms is not set up: list cms() in the extensions of kay.config.ts')

  return current
}

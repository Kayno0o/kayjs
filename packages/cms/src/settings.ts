import type { Guard, GuardContext } from 'kay'
import type { FileSaver, Identity } from './files'
import { workingTree } from './files'

// A guard built when the first request reaches it, so kay.config.ts imports nothing of the app's auth or database: `{ load: async () => (await import('./src/auth')).auth.guard({ require: 'editor' }) }`.
export interface LazyGuard {
  load: () => Guard | Promise<Guard>
}

export interface CmsOptions {
  // Where the collection screens live, `/admin` by default.
  prefix?: string | undefined
  // Who may use the screens and the API, such as kayjs-auth's `auth.guard({ require: 'editor' })`, or `{ load }` returning it, which runs on the first request rather than as kay.config.ts loads. With one, every save needs it, edit mode included; without one, only an edit-mode request gets through.
  guard?: Guard | LazyGuard | undefined
  // Where a folder entry's file goes: `forgejo(...)` on a deployed site, the working tree by default, for `kay dev`.
  files?: FileSaver | undefined
  // The types an upload may have, exact or as `image/*`: PNG, JPEG, WebP, GIF, AVIF and PDF by default.
  uploads?: string[] | undefined
  // Collections whose bodies may hold HTML that runs as the site, such as a `<script>` or an `onclick`, which a save is otherwise refused for.
  rawHtml?: string[] | undefined
  // Who a save the guard let through is committed as, from the guard's context: `async ({ locals }) => ...` reading the signed-in user.
  author?: ((ctx: GuardContext) => Identity | undefined | Promise<Identity | undefined>) | undefined
}

export interface CmsSettings {
  prefix: string
  guard: Guard | undefined
  files: FileSaver
  uploads: string[]
  rawHtml: ReadonlySet<string>
  author: CmsOptions['author']
}

const DEFAULT_UPLOADS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'application/pdf']

let current: CmsSettings | undefined

export function configure({ prefix = '/admin', guard, files = workingTree(), uploads = DEFAULT_UPLOADS, rawHtml = [], author }: CmsOptions): CmsSettings {
  current = { prefix: prefix.replace(/\/+$/, '') || '/', guard: guard === undefined ? undefined : lazily(guard), files, uploads, rawHtml: new Set(rawHtml), author }

  return current
}

// A guard that loads on its first call, and tries again after a load that failed.
function lazily(guard: Guard | LazyGuard): Guard {
  if (typeof guard === 'function')
    return guard

  const { load: build } = guard
  let loaded: Promise<Guard> | undefined

  async function load(): Promise<Guard> {
    // Forgetting a failure must come after `loaded` is set, even when the loader throws at once.
    await Promise.resolve()

    try {
      return await build()
    }
    catch (error) {
      loaded = undefined

      throw error
    }
  }

  return async (ctx) => {
    loaded ??= load()

    return (await loaded)(ctx)
  }
}

// What `cms()` in kay.config.ts was given.
export function settings(): CmsSettings {
  if (!current)
    throw new Error('kayjs-cms is not set up: list cms() in the extensions of kay.config.ts')

  return current
}

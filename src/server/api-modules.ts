import type { BunPlugin } from 'bun'
import type { KayConfig } from '../config'
import type { RouteMount } from './routes'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { KayError } from '../compiler/errors'
import { projectPaths } from '../project'
import { apiMounts, directoriesUp, falseKeys, fileAt } from './routes'

// The API modules of a project and where they are served, apart from `./api` so `kay check` and the editor, which only list them, load no Elysia.
// A module under the API directory or an extension's, as `pages()` mounts it.
export interface ApiModule {
  file: string
  // Where its routes are served: `/api/chat` for `src/api/chat.ts`, `/api` for `src/api/index.ts`.
  mount: string
  // The `_guard.ts` files of its directory and above, outermost first.
  guards: ApiGuard[]
  // No guard is asked of it on a site with `requireGuards`: it sets `api({ guards: false })`, or a library serves it.
  open?: true | undefined
}

export interface ApiGuard {
  file: string
  // Where it sits as the API directory and the extensions' laid over it read, whatever machine built the server: `admin/_guard.ts`.
  path: string
}

export const API_PREFIX = '/api'
export const OPENAPI_PATH = `${API_PREFIX}/openapi.json`
export const REFERENCE_PATH = `${API_PREFIX}/reference`
const GUARD = '_guard.ts'
const API_OPTIONS = /\bapi\s*\(\s*\{/
// Tests, declarations, and files or directories starting with `_`, guards and helpers, are no modules.
const NOT_A_MODULE = /(?:^|\/)_|\.(?:test|spec|d)\.ts$/
const TS_FILE = /\.ts$/
const INDEX = /(?:^|\/)index$/
const TRAILING_SLASH = /\/$/
// What `dirname` gives a file at the top of its directory, as the prefix ends the path.
const CURRENT_DIR = /\/\.$/

// What Elysia reads as a parameter or a wildcard, or breaks the code it generates on, in a mount path.
const ROUTER_SYNTAX = /[:*']/
const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/g

// The app's API modules and its extensions', as `pages()` serves them.
export async function projectApi(root: string, config: Pick<KayConfig, 'api' | 'extensions'>): Promise<ApiModule[]> {
  const [app, ...mounts] = apiTrees(root, config)

  return scanApi(app!.dir, mounts)
}

// The app's API directory at the root of the API tree, then each extension's under its prefix.
export function apiTrees(root: string, config: Pick<KayConfig, 'api' | 'extensions'>): RouteMount[] {
  return [{ dir: projectPaths(root, config).api, prefix: '' }, ...apiMounts(root, config.extensions)]
}

// Every module under `apiDir`, mounted at `/api` plus its path there, then each mounted library's under its prefix that no module before it is served at.
export async function scanApi(apiDir: string, mounts: RouteMount[] = []): Promise<ApiModule[]> {
  const trees = [{ dir: apiDir, prefix: '' }, ...mounts]
  const modules: ApiModule[] = []

  for (const [index, { dir, prefix }] of trees.entries()) {
    if (!existsSync(dir))
      continue

    const taken = new Set(modules.map(module => module.mount))

    for await (const path of new Bun.Glob('**/*.ts').scan({ cwd: dir })) {
      const name = path.split(sep).join('/')

      if (NOT_A_MODULE.test(name))
        continue

      if (ROUTER_SYNTAX.test(name))
        throw new KayError('route-invalid', `kay: ${join(dir, path)} has a :, * or ' in its path, which the router cannot mount; rename it`)

      const mount = mountOf(prefix, name)
      const at = `${prefix}/${dirname(name)}`.replace(CURRENT_DIR, '')

      // The app's module, or an earlier library's, at the same path replaces a library's.
      if (index > 0 && taken.has(mount))
        continue

      const file = join(dir, path)
      const open = falseKeys(await Bun.file(file).text(), API_OPTIONS).has('guards')

      modules.push({ file, mount, guards: open ? [] : guardsAt(trees, at), ...(open || index > 0) && { open: true } })
    }
  }

  // By UTF-16 code unit, as every machine orders them alike.
  return modules.sort((a, b) => a.file < b.file ? -1 : Number(a.file > b.file))
}

// The guards every module runs, the API directory's own first; with none of its own, those of a directory holding every module. A module setting `guards: false` runs none and leaves them as they are.
export function sharedGuards(modules: ApiModule[]): string[] {
  const [first, ...rest] = modules.filter(module => module.open !== true || module.guards.length > 0)
  const shared: string[] = []

  for (const [index, guard] of first?.guards.entries() ?? []) {
    if (!rest.every(module => module.guards[index]?.file === guard.file))
      break

    shared.push(guard.file)
  }

  return shared
}

// Where a module at `name` in a tree mounted at `prefix` is served: `/api/auth/session` for `session.ts` under `/auth`.
function mountOf(prefix: string, name: string): string {
  return `${API_PREFIX}${`${prefix}/${name.replace(TS_FILE, '').replace(INDEX, '')}`.replace(TRAILING_SLASH, '')}`
}

// The guards of a directory of the API tree and above, `''` for its root, outermost first: the app's at each level, else a library's.
function guardsAt(trees: RouteMount[], at: string): ApiGuard[] {
  return directoriesUp(at).flatMap((dir) => {
    const file = fileAt(trees, dir, GUARD)

    return file === undefined ? [] : [{ file, path: `${dir}/${GUARD}`.slice(1) }]
  }).reverse()
}

// In the browser build an island imports a module of one of the API `trees` for its routes' types only: it gets where they are served, and none of the server code.
// A library module the app replaced gives the app's mount, which is the same path, so a library island importing it still builds.
export function apiStubs(trees: RouteMount[]): BunPlugin {
  // A tree reached through a link, a library linked into the app, is matched by its real path too, which Bun hands for a module imported from the real side.
  const reached = trees.flatMap(tree => [...new Set([tree.dir, existsSync(tree.dir) ? realpathSync(tree.dir) : tree.dir])].map(dir => ({ dir, prefix: tree.prefix })))

  return {
    name: 'kay-api',
    setup(build) {
      build.onLoad({ filter: new RegExp(`^(?:${reached.map(({ dir }) => (dir + sep).replace(REGEX_SYNTAX, '\\$&')).join('|')}).*\\.ts$`) }, ({ path }) => {
        const { dir, prefix } = reached.find(tree => path.startsWith(tree.dir + sep))!
        const name = relative(dir, path).split(sep).join('/')

        if (NOT_A_MODULE.test(name))
          throw new KayError('route-invalid', `kay: an island imports ${name}, which is no module under ${basename(dir)}: only a module's default export reaches the browser, as where its routes are served`)

        return { contents: `export default { [Symbol.for('kay.api')]: ${JSON.stringify(mountOf(prefix, name))} }`, loader: 'js' }
      })
    },
  }
}

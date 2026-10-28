import type { AnyElysia } from 'elysia'
import type { ExtensionApp, KayExtension } from './config'
import type { PageHook } from './server/page-hook'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { KayError } from './compiler/errors'
import { appStore } from './server/app-store'
import { bundled, importModule } from './server/bundle'

// The directory of the app's own server plugins, whose files `pages()` uses before the extensions', in the order of their names.
export const PLUGINS_DIR = 'src/plugins'
const PLUGIN_FILE = /^[^_.][^.]*\.ts$/

// The file names of the app's server plugins, in the order they are used.
export function pluginFiles(root: string): string[] {
  const dir = join(root, PLUGINS_DIR)

  return existsSync(dir) ? readdirSync(dir).filter(name => PLUGIN_FILE.test(name)).sort() : []
}

// The app's `src/plugins/*.ts` as extensions carrying a server module, then the config's extensions: every server plugin `pages()` mounts, in the order it mounts them. An executable gives the `files` it was built with, as it holds no such directory.
export function serverExtensions(root: string, extensions: KayExtension[] | undefined, files = pluginFiles(root)): KayExtension[] {
  return [...files.map(name => ({ name: `${PLUGINS_DIR}/${name}`, serverModule: { path: `./${PLUGINS_DIR}/${name}` } })), ...extensions ?? []]
}

const testSites = new AsyncLocalStorage<Bun.CookieMap>()

// Runs `build` as the app of the test site holding `cookies`, so the extensions it builds are handed them.
export async function buildingTestSite<T>(cookies: Bun.CookieMap, build: () => Promise<T>): Promise<T> {
  return testSites.run(cookies, build)
}

// What kay hands an extension's `server` function and the API modules of its `api` directory exporting a function: built afresh at each call, its `appFiles` imported again.
// Made where the extensions' servers are, so it sees the test site being built and the extensions the config lists.
export function extensionApps(extensions: KayExtension[] | undefined, root: string, exporting = false): (extension: Pick<KayExtension, 'name' | 'appFiles'>) => Promise<ExtensionApp> {
  const testCookies = testSites.getStore()
  // An extension carrying only a catalog of messages is what an installed library's `kay.messages` adds to every app, not something the config lists.
  const names = (extensions ?? []).filter(extension => Object.keys(extension).some(key => key !== 'name' && key !== 'messages')).map(extension => extension.name)

  return async extension => ({ root: bundled() ? process.cwd() : root, modules: await appModules(root, extension), extensions: names, testCookies, database: appStore()?.database, exporting })
}

// The server plugins the extensions carry, in their order, those given as a function built now.
export async function extensionServers(extensions: KayExtension[] | undefined, root: string, exporting = false): Promise<{ name: string, server: AnyElysia }[]> {
  const appOf = extensionApps(extensions, root, exporting)

  return Promise.all((extensions ?? []).flatMap((extension) => {
    const { name, server, serverModule } = extension

    if (serverModule !== undefined)
      return [(async () => ({ name, server: await serverFromModule(name, serverModule, root) }))()]

    return server === undefined ? [] : [(async () => ({ name, server: typeof server === 'function' ? await server(await appOf(extension)) : server }))()]
  }))
}

function isUnder(root: string, file: string): boolean {
  const inside = relative(root, file)

  return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
}

// Whether something is at the path: a link leading nowhere, or a path through a file, which cannot be told apart from it.
function linked(file: string): boolean {
  try {
    return lstatSync(file, { throwIfNoEntry: false }) !== undefined
  }
  catch {
    return true
  }
}

// The real path of a file or, for one not written yet, of its nearest folder that exists with the rest of the name after it; undefined for a link that leads nowhere.
function realPathOf(file: string): string | undefined {
  try {
    return realpathSync(file)
  }
  catch {
    if (linked(file))
      return undefined

    const parent = dirname(file)

    if (parent === file)
      return file

    const real = realPathOf(parent)

    return real === undefined ? undefined : join(real, basename(file))
  }
}

// The file of `path` under `root` that an extension names in `appFiles`, refusing one outside the root, a link out of it included.
// An executable holds copies of the files, so no link is followed there.
function appFileOf(root: string, extension: string, name: string, path: string): string {
  const file = resolve(root, path)
  const held = bundled() !== undefined
  const real = held ? file : realPathOf(file)
  const realRoot = held ? root : realPathOf(root)

  if (!isUnder(root, file) || real === undefined || realRoot === undefined || !isUnder(realRoot, real))
    throw new KayError('config-invalid', `kay: the extension ${extension} names its file ${name} as ${path}, which is not under the project root`)

  return file
}

function hasAppFile(file: string): boolean {
  const held = bundled()

  return held ? file in held.modules : statSync(file, { throwIfNoEntry: false })?.isFile() === true
}

// The files the extensions name in `appFiles`, absolute under the project root, written or not.
export function declaredAppFiles(root: string, extensions: KayExtension[] | undefined): string[] {
  return (extensions ?? []).flatMap(({ name, appFiles }) => Object.entries(appFiles ?? {}).map(([key, path]) => appFileOf(root, name, key, path)))
}

// Those of them the app has written.
export function extensionAppFiles(root: string, extensions: KayExtension[] | undefined): string[] {
  return declaredAppFiles(root, extensions).filter(file => hasAppFile(file))
}

// The modules of the files an extension names in `appFiles`, undefined for one the app has not written; an executable holds the copies its build found under the root it was built in.
export async function appModules(root: string, { name, appFiles }: Pick<KayExtension, 'name' | 'appFiles'>): Promise<ExtensionApp['modules']> {
  const base = bundled()?.root ?? root

  return Object.fromEntries(await Promise.all(Object.entries(appFiles ?? {}).map(async ([key, path]) => {
    const file = appFileOf(base, name, key, path)

    return [key, hasAppFile(file) ? await importModule<Record<string, unknown>>(file) : undefined] as const
  })))
}

// The `context` modules of the extensions, as absolute paths: an executable reads the copy it holds, keyed by where the build found the file.
export function extensionContexts(root: string, extensions: KayExtension[] | undefined): string[] {
  return (extensions ?? []).flatMap(({ context }) => context === undefined ? [] : [resolve(bundled()?.root ?? root, context)])
}

// The module files the extensions name their server plugin by, as the executable holds them.
export function extensionServerModules(root: string, extensions: KayExtension[] | undefined): string[] {
  return (extensions ?? []).flatMap(({ serverModule }) => serverModule === undefined ? [] : [resolve(root, serverModule.path)])
}

// The plugin a module exports, what a function it exports builds, or the `plugin` of an object it exports; an executable reads it from the copy it holds, keyed by where the build found the file.
async function serverFromModule(name: string, { path, export: exported = 'default', prepare }: NonNullable<KayExtension['serverModule']>, root: string): Promise<AnyElysia> {
  const file = resolve(bundled()?.root ?? root, path)
  const value = (await importModule<Record<string, unknown>>(file))[exported]

  await prepare?.(value)

  const built = typeof value === 'function' ? await (value as () => unknown)() : value
  const server = typeof built === 'object' && built !== null && !('handle' in built) && 'plugin' in built ? built.plugin : built

  if (typeof server !== 'object' || server === null || !('handle' in server))
    throw new KayError('config-invalid', `kay: the extension ${name} takes its server from ${path}, which does not export an Elysia plugin as \`${exported}\``)

  return server as AnyElysia
}

// The page hooks the extensions carry, in their order.
export function pageHooks(extensions: KayExtension[] | undefined): PageHook[] {
  return (extensions ?? []).flatMap(extension => extension.transformPage === undefined ? [] : [extension.transformPage])
}

import type { KayConfig } from './config'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { libraryMessageExtensions } from './build/manifests'
import { KayError } from './compiler/errors'
import { CONFIG_FILE } from './config'
import { publicEnvFiles } from './server/env-state'

// `fresh` reads the file again as it is now, as `kay dev` does once it changed, rather than the module this process imported first.
export async function loadConfig(root: string, fresh = false): Promise<KayConfig> {
  return withSiteUrl(withPublicFields(root, withExtensions(withLibraryMessages(root, await importConfig(root, fresh)))))
}

const CONFIG_TIMEOUT = 30_000

// `loadConfig` for a command or an editor that must not hang on a config awaiting something that never comes, such as a database that does not answer: it fails after `timeout` ms, the import left to finish or not.
export async function loadConfigWithin(root: string, timeout = CONFIG_TIMEOUT): Promise<KayConfig> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      loadConfig(root),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new KayError('config-invalid', `kay: ${CONFIG_FILE} did not load within ${timeout / 1000}s, so it awaits something that never settles`)), timeout)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

const SERVER_SPECIFIER = /(['"])kay\/server\1/g
const SERVER_NAMES_IMPORT = /\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])kay\/server\3/g
const TYPE_PREFIX = /^type\s/
// Created on first use: this module is also bundled for Node, where `Bun` does not exist at load.
let sourceTranspiler: Bun.Transpiler | undefined
const transpiler = () => sourceTranspiler ??= new Bun.Transpiler({ loader: 'ts' })
// The module holding `defineConfig` and nothing else at run time, which a light config imports in place of `kay/server`: found on first use, as `import.meta.dir` is Bun's alone.
const schemaModule = () => join(import.meta.dir, 'config.ts')
// The config files read without the server: their `kay/server` import takes only `defineConfig`, which the module `schemaModule()` names holds, so a process building the client or writing the types skips loading Elysia and the rest of the server.
const lightConfigs = new Set<string>()

// The config's source with its `kay/server` import pointed at `schemaModule()`, or undefined when it takes anything else from there.
// The imports the transpiler finds must be exactly the ones matched, so a comment, a string or a dynamic import naming the module leaves the server loaded.
function withoutServer(source: string): string | undefined {
  const named = [...source.matchAll(SERVER_NAMES_IMPORT)]

  if (named.length === 0 || named.length !== transpiler().scanImports(source).filter(({ path }) => path === 'kay/server').length)
    return undefined

  const onlyDefineConfig = named.every(([, type, names]) => type !== undefined || names!.split(',').map(name => name.trim()).filter(name => name !== '').every(name => TYPE_PREFIX.test(name) || name === 'defineConfig'))

  return onlyDefineConfig ? source.replace(SERVER_NAMES_IMPORT, statement => statement.replace(SERVER_SPECIFIER, () => JSON.stringify(schemaModule()))) : undefined
}

// A runtime plugin cannot resolve a bare specifier, so the config's source is rewritten as it loads.
// The plugin takes only this file, and only when it is light, as a loader answering nothing for a file fails and one answering for every config would keep later plugins from theirs.
// It stays registered for that one file, which the server loader's plugin also answers for.
async function readConfigLightly(file: string): Promise<void> {
  const real = realpathSync(file)

  if (lightConfigs.has(real) || withoutServer(await Bun.file(real).text()) === undefined)
    return

  lightConfigs.add(real)
  Bun.plugin({
    name: 'kay-config',
    setup(build) {
      build.onLoad({ filter: new RegExp(`^${RegExp.escape(real)}(?:\\?.*)?$`) }, async () => {
        const source = await Bun.file(real).text()

        return { contents: withoutServer(source) ?? source, loader: 'ts' as const }
      })
    },
  })
}

// The config as `kay.config.ts` writes it, its extensions' config not laid under it yet.
async function importConfig(root: string, fresh = false): Promise<KayConfig> {
  const file = join(root, CONFIG_FILE)

  if (!existsSync(file))
    return {}

  await readConfigLightly(file)

  const { default: config } = await importedConfig(file, fresh)

  if (typeof config !== 'object' || config === null)
    throw new KayError('config-default-export', `kay: ${CONFIG_FILE} must export its config by default: export default defineConfig({ ... })`)

  checkedConfig(config)

  return config
}

const MODULE_DIRECTORY = /^.*\/node_modules\//
const MODULE_ENTRY = /\/src\/index\.ts$/
const REMOVED_EXPORT = /Export named '([^']+)' not found in module '([^']+)'/
// What replaced the exports a config imported and a release removed, as llms/upgrading.md names them.
const REPLACED_EXPORTS: Record<string, string> = {
  authPages: 'auth({ module })',
  authExtension: 'auth({ module })',
  mailExtension: 'mail({ module })',
}

// The config's import, a missing export reported as the removal it is rather than as Bun's bare module error, so `kay check` and `kay upgrade` point at the note that renames it.
async function importedConfig(file: string, fresh: boolean): Promise<{ default?: KayConfig }> {
  try {
    return await import(fresh ? `${file}?${Date.now()}` : file) as { default?: KayConfig }
  }
  catch (error) {
    const removed = error instanceof SyntaxError ? REMOVED_EXPORT.exec(error.message) : null

    if (removed === null)
      throw error

    const [, name = '', source = ''] = removed
    const replacement = REPLACED_EXPORTS[name]

    throw new KayError('config-invalid', `kay: ${CONFIG_FILE} imports \`${name}\` from ${JSON.stringify(source.replace(MODULE_DIRECTORY, '').replace(MODULE_ENTRY, ''))}, which no longer exports it${replacement === undefined ? '' : `: use ${replacement}`}; llms/upgrading.md lists what each release removed and what replaced it`)
  }
}

// The keys `kay check` and `kay env` read in their own way, refused when they are not the shape they take.
function checkedConfig({ checks, env, publicEnv }: KayConfig, where = CONFIG_FILE): void {
  if (publicEnv !== undefined)
    throw new KayError('config-invalid', `kay: \`publicEnv\` in ${where} is gone: mark the fields an island reads \`s.Public\` in \`defineEnv\` instead`)

  if (checks !== undefined && !Array.isArray(checks))
    throw new KayError('config-invalid', `kay: \`checks\` in ${where} is a list of functions, not ${typeof checks}`)

  const notFunction = (checks ?? []).findIndex(check => typeof check !== 'function')

  if (notFunction >= 0)
    throw new KayError('config-invalid', `kay: \`checks[${notFunction}]\` in ${where} is not a function`)

  if (env === undefined || env === false)
    return

  const { compose, example } = (typeof env === 'object' && env !== null ? env : {}) as { compose?: unknown, example?: unknown }
  const files = Array.isArray(compose) ? compose : [compose]

  if (typeof env !== 'object' || env === null || Array.isArray(env) || files.some(file => file !== undefined && typeof file !== 'string') || (example !== undefined && typeof example !== 'string'))
    throw new KayError('config-invalid', `kay: \`env\` in ${where} is \`{ compose, example }\`, each a file name (\`compose\` may be a list of them), or \`false\``)
}

// The config with the catalogs of the libraries the app installs listed before its own extensions, so those and the app's messages win key by key; one an extension of the same name already brings is left alone.
function withLibraryMessages(root: string, config: KayConfig): KayConfig {
  const listed = new Set((config.extensions ?? []).filter(({ messages }) => messages !== undefined).map(({ name }) => name))
  const shipped = libraryMessageExtensions(root).filter(({ name }) => !listed.has(name))

  return shipped.length === 0 ? config : { ...config, extensions: [...shipped, ...config.extensions ?? []] }
}

// The config with each extension's own laid under it, a later extension's over an earlier one's.
function withExtensions<Config extends KayConfig>(config: Config): Config {
  const layers = (config.extensions ?? []).flatMap((extension) => {
    if (extension.config === undefined)
      return []

    checkedConfig(extension.config, `the config of the extension ${extension.name}`)

    return [extension.config]
  })

  if (layers.length === 0)
    return config

  return underlay(layers.reduce<KayConfig>((under, layer) => underlay(under, layer) as KayConfig, {}), config) as Config
}

// `over` merged onto `under`: plain objects key by key, arrays joined, anything else `over`'s unless it leaves it undefined.
function underlay(under: unknown, over: unknown): unknown {
  if (over === undefined)
    return under

  if (Array.isArray(under) && Array.isArray(over))
    return [...under, ...over]

  if (!isPlainObject(under) || !isPlainObject(over))
    return over

  const merged: Record<string, unknown> = { ...under }

  for (const [key, value] of Object.entries(over))
    merged[key] = underlay(under[key], value)

  return merged
}

// A value built by a class, such as a schema with symbol keys, stays whole: a merge would drop them.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Object.getOwnPropertySymbols(value).length > 0)
    return false

  const prototype: unknown = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

// The site's URL the environment gives: `SITE_URL`, which the app set for kay and so fails loudly when wrong.
export function siteFromEnv(): string | undefined {
  const { SITE_URL } = process.env

  return SITE_URL !== undefined && SITE_URL !== '' ? SITE_URL : undefined
}

// A project with a `s.Public` field in `src` sends the browser an environment: `publicEnv` stands for it, as the fields themselves register as `defineEnv` reads them.
function withPublicFields<Config extends KayConfig>(root: string, config: Config): Config {
  return typeof Bun === 'undefined' || publicEnvFiles(root).length === 0 ? config : { ...config, publicEnv: true }
}

function withSiteUrl<Config extends KayConfig>(config: Config): Config {
  const site = siteFromEnv()

  return config.site !== undefined || site === undefined ? config : { ...config, site }
}

// The project's config under the options given in code; an option passed as `undefined` leaves the config's value alone rather than wiping it.
export async function withConfig<Options extends KayConfig>(root: string, options: Options): Promise<KayConfig & Options> {
  return withPublicFields(root, mergeConfig(withLibraryMessages(root, await importConfig(root)), options))
}

// `config` is as `kay.config.ts` writes it, so the extensions the options name lie under it rather than the file's.
export function mergeConfig<Options extends KayConfig>(config: KayConfig, options: Options): KayConfig & Options {
  return withSiteUrl(withExtensions({ ...config, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) } as KayConfig & Options))
}

import type { BunPlugin } from 'bun'
import type { Project } from '../project'
import type { Route, SpecialPages } from '../server/routes'
import { existsSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { buildFailure, KayError, raisedMark } from '../compiler/errors'
import { CONFIG_FILE, extensionAppFiles, extensionServerModules, pluginFiles, serverExtensions } from '../config'
import { PAGES_ENTRY } from '../dev/sources'
import { projectApi } from '../server/api-modules'
import { AVIF_WORKER_SOURCE } from '../server/avif'
import { DEFAULT_LANG, extensionMessageFiles, messagesFile } from '../server/i18n'
import { matcherFile } from '../server/params'
import { refuseClashes } from '../server/route-table'
import { extensionEditor, routeMounts, routeTrees, scanEndpoints, scanRoutes, specialPagesOf } from '../server/routes'
import { installedDependencies, NOTICES_FILE, thirdPartyNotices } from './licenses'
import { kay } from './plugin'
import { withoutPlugins, withProjectPaths } from './runtime-config'
import { withoutStyles } from './styles'

export interface CompileOptions {
  // The server entry, `src/server.ts` under the root by default; with no file there, kay's own server of the pages.
  entry?: string | undefined
  outfile: string
  // The packages the browser build ships, credited with the server's in what `--licenses` prints.
  packages?: string[] | undefined
}

// Bun embeds an asset directory under its last path component, beside the executable's entry.
const CLIENT_ASSETS = 'client'
// What a server reading the build it embeds never runs, each with what it says if called: the client bundler, the `.kay` loader and the prerenderer, which bring the compiler, the dev tool's Head and Sizes tabs, which reach it too, and the SVG favicon drawer, which brings resvg.
const LEFT_OUT_MODULES = new Map([
  [join(import.meta.dir, 'client.ts'), 'an executable serves the build it embeds, and carries no compiler'],
  [join(import.meta.dir, 'plugin.ts'), 'an executable serves the build it embeds, and carries no compiler'],
  [join(import.meta.dir, '../server/svg-icon.ts'), 'an executable serves the favicons `kay build` drew, and carries no SVG drawer'],
  [join(import.meta.dir, '../server/dev-head.ts'), 'an executable runs in production, where the dev tool\'s Head tab does not exist'],
  [join(import.meta.dir, '../server/dev-sizes.ts'), 'an executable runs in production, where the dev tool\'s Sizes tab does not exist'],
  [join(import.meta.dir, '../server/prerender.ts'), 'an executable serves the pages `kay build` prerendered, and carries no compiler to read a template with'],
])
const LEFT_OUT = 'kay-left-out'
const RELATIVE = /^\.\.?\//
const ANY = /.*/
const AVIF_WASM = /(?:\/src\/server\/codec\/avif-enc|\/@jsquash\/avif\/codec\/dec\/avif_dec)\.wasm$/

// Leaves the compiler and resvg out of the executable: megabytes the server never runs.
function withoutCompiler(): BunPlugin {
  return {
    name: 'kay-without-compiler',
    setup(build) {
      build.onResolve({ filter: RELATIVE }, ({ path, importer }) => {
        const file = `${resolve(dirname(importer), path)}.ts`

        return LEFT_OUT_MODULES.has(file) ? { path: file, namespace: LEFT_OUT } : undefined
      })
      build.onLoad({ filter: ANY, namespace: LEFT_OUT }, ({ path }) => ({ contents: `throw new Error(${JSON.stringify(`kay: ${LEFT_OUT_MODULES.get(path)}`)})`, loader: 'js' }))
    },
  }
}

// Embeds the AVIF coders' wasm zstd-compressed, which the worker unpacks on first use.
function compressedWasm(): BunPlugin {
  return {
    name: 'kay-compressed-wasm',
    setup(build) {
      build.onLoad({ filter: AVIF_WASM }, async ({ path }) => ({ contents: await Bun.zstdCompress(await Bun.file(path).bytes(), { level: 10 }), loader: 'file' }))
    },
  }
}

// The project's server entry, else kay's own, which only mounts the pages.
function ownEntry(entry: string): string {
  return existsSync(entry) ? entry : PAGES_ENTRY
}

// Bundles the server, its pages and the client build `kay build` wrote into one executable, which runs as `NODE_ENV=production bun <entry>` would.
// The entry it generates registers every route module before the server entry calls `pages()`, which then reads nothing from disk but the embedded files.
export async function compileServer(project: Project, options: CompileOptions): Promise<string> {
  const { root, config, paths } = project
  const { routes: routesDir, public: publicDir, output: clientBase } = paths
  const entry = options.entry === undefined ? ownEntry(paths.entry) : resolve(root, options.entry)
  const outfile = resolve(root, options.outfile)

  if (!existsSync(entry))
    throw new KayError('executable-invalid', `kay: no server entry at ${entry}; pass --entry`)

  if (basename(publicDir) === CLIENT_ASSETS)
    throw new KayError('executable-invalid', `kay: an executable embeds its public files and the client build side by side, so the public directory cannot be named ${CLIENT_ASSETS}`)

  const mounts = routeMounts(root, config.extensions)
  const routes = await scanRoutes(routesDir, mounts)

  refuseClashes(routesDir, routes)

  const fallback = specialPagesOf(routeTrees(routesDir, mounts), '')
  const contentConfig = paths.content
  // The content config too, which the server reads the collections and their feeds from, the project's own param matchers and every locale's messages, its extensions' included.
  const matcherFiles = [...new Set(routes.flatMap(route => Object.values(route.matchers ?? {})))].map(name => matcherFile(routesDir, name)).filter(file => existsSync(file))
  const locales = config.i18n?.locales ?? [config.lang ?? DEFAULT_LANG]
  const extensionMessages = Object.fromEntries(locales.map(locale => [locale, extensionMessageFiles(root, config.extensions, locale).filter(file => existsSync(file))]))
  const messageFiles = [...Object.values(extensionMessages).flat(), ...locales.map(locale => messagesFile(root, config.i18n ?? {}, locale)).filter(file => existsSync(file))]
  // The API modules too, with their guards, which `pages()` mounts from the list rather than the directory.
  const api = await projectApi(root, config)
  const plugins = pluginFiles(root)
  const endpoints = await scanEndpoints(routesDir, mounts)
  const editor = extensionEditor(root, config.extensions)
  const modules = [...new Set([...routeModules(routes, fallback), ...editor === undefined ? [] : [editor], ...extensionServerModules(root, serverExtensions(root, config.extensions, plugins)), ...extensionAppFiles(root, config.extensions), ...existsSync(contentConfig) ? [contentConfig] : [], ...matcherFiles, ...messageFiles, ...[...api, ...endpoints].flatMap(module => [module.file, ...module.guards.map(guard => guard.file)])])]
  const configFile = join(root, CONFIG_FILE)
  const generated = join(paths.compile, 'entry.ts')
  const embedded = (dir: string) => `join(import.meta.dir, ${JSON.stringify(basename(dir))})`

  const notices = join(paths.compile, NOTICES_FILE)

  await Bun.write(notices, thirdPartyNotices([...installedDependencies(root), ...options.packages ?? []], { executable: true }))
  await Bun.write(generated, [
    `import { join } from 'node:path'`,
    `import process from 'node:process'`,
    `import { buildingWithoutEnv, listenIdleApps, probeHealth, registerBundle } from 'kay/internal/server'`,
    // An embedded file, read only for `--licenses`, so the server keeps none of it in memory.
    `import notices from ${JSON.stringify(notices)} with { type: 'file' }`,
    '',
    'if (process.argv.includes(\'--licenses\')) {',
    '  process.stdout.write(await Bun.file(notices).text())',
    '  process.exit(0)',
    '}',
    '',
    // For code reading it off `node:process`, as kay does, which the build's `define` leaves alone.
    'Bun.env.NODE_ENV = \'production\'',
    '',
    // `--load` loads every module and stops before the server entry, which is where a database or a secret is asked for: a variable missing fails the code reading it, not the module declaring it, as under `kay build`.
    'const loading = process.argv.includes(\'--load\')',
    '',
    'if (loading)',
    '  buildingWithoutEnv()',
    '',
    existsSync(configFile) ? `const { default: config } = await import(${JSON.stringify(configFile)})` : 'const config = {}',
    '',
    // Asks the server running beside it, rather than starting one, before any module of the app loads: a container's health check runs it every few seconds.
    'if (process.argv.includes(\'--health\'))',
    '  process.exit(await probeHealth(config.health))',
    '',
    ...modules.map((file, index) => `const module${index} = await import(${JSON.stringify(file)})`),
    '',
    'if (loading)',
    '  process.exit(0)',
    '',
    'registerBundle({',
    `  root: ${JSON.stringify(root)},`,
    `  routes: ${JSON.stringify(routes)},`,
    `  fallback: ${JSON.stringify(fallback)},`,
    `  api: ${JSON.stringify(api)},`,
    `  endpoints: ${JSON.stringify(endpoints)},`,
    `  plugins: ${JSON.stringify(plugins)},`,
    `  extensionMessages: ${JSON.stringify(extensionMessages)},`,
    ...editor === undefined ? [] : [`  editor: ${JSON.stringify(editor)},`],
    `  modules: { ${modules.map((file, index) => `${JSON.stringify(file)}: module${index}`).join(', ')} },`,
    '  config,',
    `  clientDir: ${embedded(clientBase)},`,
    `  publicDir: ${embedded(publicDir)},`,
    '})',
    '',
    `await import(${JSON.stringify(entry)})`,
    'listenIdleApps()',
    '',
  ].join('\n'))

  const configSource = existsSync(configFile) ? await Bun.file(configFile).text() : undefined
  const runtime = configSource === undefined ? undefined : withoutPlugins(configSource)

  if (runtime === undefined && (config.plugins?.length ?? 0) > 0)
    console.warn(`kay: the plugins in ${CONFIG_FILE} cannot be told apart from the rest of the config, which they can as a property of the object it exports by default with no spread beside them, so the executable carries them; one loading a native addon, as Tailwind does, fails where the project's node_modules is not`)

  // Bun loads a module by its real path, a symlinked project's included.
  const realConfig = configSource === undefined ? undefined : realpathSync(configFile)
  // The config as the executable loads it: without its build plugins, which cannot load there, and with `import.meta.dir` naming the project's folder, as inside the executable it would name `/$bunfs/root`.
  const rewrite = (file: string, source: string) => file === realConfig ? withProjectPaths(runtime ?? source, file) : source
  const since = raisedMark()
  const build = await Bun.build({
    // The AVIF encoder's worker too, which the executable starts from `/$bunfs/root/avif-worker.js`.
    entrypoints: [generated, AVIF_WORKER_SOURCE],
    naming: { entry: '[name].[ext]' },
    target: 'bun',
    // Parsed at build time: the server starts in a third of the time, for a few more megabytes of executable.
    bytecode: true,
    // Bun maps a frame to the file and line it came from, which for a `.kay` file is the code kay generated: each module carries what maps that to its `.kay` lines.
    sourcemap: 'external',
    format: 'esm',
    compile: { outfile, assets: [clientBase, publicDir].filter(dir => existsSync(dir)) },
    // The production code of the app and its packages, as `NODE_ENV=production` gives a server started with Bun.
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    // Stylesheets reach pages through the client build, already embedded.
    plugins: [withoutStyles(), withoutCompiler(), compressedWasm(), kay({ target: 'ssr', root, cacheDir: paths.cache, settings: config.settings, placeholder: config.images?.placeholder, embedMaps: true, rewrite }), ...config.plugins ?? []],
  })

  if (!build.success)
    throw buildFailure(build.logs, 'kay: compiling the server failed', since)

  // The executable embeds the maps; the files Bun also writes beside it would be dead weight.
  await Promise.all(build.outputs.filter(output => output.kind === 'sourcemap').map(async output => rm(output.path, { force: true })))

  return outfile
}

// Every module a route renders or runs: its page, layouts, special pages and guards, its layouts' own included.
function routeModules(routes: Route[], fallback: SpecialPages): Set<string> {
  const files = new Set<string>()
  const addSpecial = (special: SpecialPages) => {
    for (const page of [special.notFound, special.error]) {
      if (page) {
        for (const file of [...page.layouts, page.file])
          files.add(file)
      }
    }
  }

  for (const route of routes) {
    for (const file of [...route.layouts, ...route.actionModules ?? [], route.file])
      files.add(file)

    addSpecial(route.special)

    for (const guard of [...route.guards, ...(route.layoutAccess ?? []).flatMap(access => access.guards), ...(route.actionAccess ?? []).flatMap(access => access.guards)]) {
      files.add(guard.file)
      addSpecial(guard.special)
    }
  }

  addSpecial(fallback)

  return files
}

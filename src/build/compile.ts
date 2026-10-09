import type { BunPlugin } from 'bun'
import type { KayConfig } from '../config'
import type { Route, SpecialPages } from '../server/routes'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { CONFIG_FILE } from '../config'
import { CONTENT_CONFIG } from '../content/server'
import { scanApi } from '../server/api'
import { AVIF_WORKER_SOURCE } from '../server/avif'
import { messagesFile } from '../server/i18n'
import { matcherFile } from '../server/params'
import { refuseClashes, scanRoutes, specialPagesOf } from '../server/routes'
import { kay } from './plugin'
import { runtimeConfig, withoutPlugins } from './runtime-config'
import { withoutStyles } from './styles'

export interface CompileOptions {
  // The server entry, `src/server.ts` under the root by default.
  entry?: string | undefined
  outfile: string
}

// Bun embeds an asset directory under its last path component, beside the executable's entry.
const CLIENT_ASSETS = 'client'
// What bundles the client and loads `.kay` files at boot, which bring the compiler: a server reading the build it embeds imports neither.
const COMPILER_MODULES = new Set([join(import.meta.dir, 'client.ts'), join(import.meta.dir, 'plugin.ts')])
const LEFT_OUT = 'kay-left-out'
const RELATIVE = /^\.\.?\//
const ANY = /.*/

// Leaves the compiler out of the executable: 2 MB the server never runs.
function withoutCompiler(): BunPlugin {
  return {
    name: 'kay-without-compiler',
    setup(build) {
      build.onResolve({ filter: RELATIVE }, ({ path, importer }) => COMPILER_MODULES.has(`${resolve(dirname(importer), path)}.ts`) ? { path, namespace: LEFT_OUT } : undefined)
      build.onLoad({ filter: ANY, namespace: LEFT_OUT }, () => ({ contents: 'throw new Error(\'kay: an executable serves the build it embeds, and carries no compiler\')', loader: 'js' }))
    },
  }
}

// Bundles the server, its pages and the client build `kay build` wrote into one executable, which runs as `NODE_ENV=production bun <entry>` would.
// The entry it generates registers every route module before the server entry calls `pages()`, which then reads nothing from disk but the embedded files.
export async function compileServer(root: string, config: KayConfig, options: CompileOptions): Promise<string> {
  const routesDir = resolve(root, config.routes ?? 'src/routes')
  const publicDir = resolve(root, config.publicDir ?? 'public')
  const clientBase = join(root, '.kay', 'client')
  const entry = resolve(root, options.entry ?? 'src/server.ts')
  const outfile = resolve(root, options.outfile)

  if (!existsSync(entry))
    throw new Error(`kay: no server entry at ${entry}; pass --entry`)

  if (basename(publicDir) === CLIENT_ASSETS)
    throw new Error(`kay: an executable embeds its public files and the client build side by side, so the public directory cannot be named ${CLIENT_ASSETS}`)

  const routes = await scanRoutes(routesDir)

  refuseClashes(routesDir, routes)

  const fallback = specialPagesOf(routesDir, routesDir)
  const contentConfig = resolve(root, config.content ?? CONTENT_CONFIG)
  // The content config too, which the server reads the collections and their feeds from, the project's own param matchers and its messages.
  const matcherFiles = [...new Set(routes.flatMap(route => Object.values(route.matchers ?? {})))].map(name => matcherFile(routesDir, name)).filter(file => existsSync(file))
  const messageFiles = config.i18n ? config.i18n.locales.map(locale => messagesFile(root, config.i18n!, locale)).filter(file => existsSync(file)) : []
  // The API modules too, with their guards, which `pages()` mounts from the list rather than the directory.
  const api = await scanApi(resolve(root, config.api ?? 'src/api'))
  const modules = [...new Set([...routeModules(routes, fallback), ...existsSync(contentConfig) ? [contentConfig] : [], ...matcherFiles, ...messageFiles, ...api.flatMap(module => [module.file, ...module.guards])])]
  const configFile = join(root, CONFIG_FILE)
  const generated = join(root, '.kay', 'compile', 'entry.ts')
  const embedded = (dir: string) => `join(import.meta.dir, ${JSON.stringify(basename(dir))})`

  await Bun.write(generated, [
    `import { join } from 'node:path'`,
    `import process from 'node:process'`,
    `import { probeHealth, registerBundle } from 'kay/internal/server'`,
    '',
    existsSync(configFile) ? `const { default: config } = await import(${JSON.stringify(configFile)})` : 'const config = {}',
    '',
    // Asks the server running beside it, rather than starting one, before any module of the app loads: a container's health check runs it every few seconds.
    'if (process.argv.includes(\'--health\'))',
    '  process.exit(await probeHealth(config.health))',
    '',
    ...modules.map((file, index) => `const module${index} = await import(${JSON.stringify(file)})`),
    '',
    'registerBundle({',
    `  root: ${JSON.stringify(root)},`,
    `  routes: ${JSON.stringify(routes)},`,
    `  fallback: ${JSON.stringify(fallback)},`,
    `  api: ${JSON.stringify(api)},`,
    `  modules: { ${modules.map((file, index) => `${JSON.stringify(file)}: module${index}`).join(', ')} },`,
    '  config,',
    `  clientDir: ${embedded(clientBase)},`,
    `  publicDir: ${embedded(publicDir)},`,
    '})',
    '',
    `await import(${JSON.stringify(entry)})`,
    '',
  ].join('\n'))

  const configSource = existsSync(configFile) ? await Bun.file(configFile).text() : undefined
  const runtime = configSource === undefined ? undefined : withoutPlugins(configSource)

  if (runtime === undefined && (config.plugins?.length ?? 0) > 0)
    console.warn(`kay: the plugins in ${CONFIG_FILE} cannot be told apart from the rest of the config, which they can as a property of the object it exports by default with no spread beside them, so the executable carries them; one loading a native addon, as Tailwind does, fails where the project's node_modules is not`)

  const configPlugins = runtime === undefined ? [] : [runtimeConfig(configFile, runtime)]
  const build = await Bun.build({
    // The AVIF encoder's worker too, which the executable starts from `/$bunfs/root/avif-worker.js`.
    entrypoints: [generated, AVIF_WORKER_SOURCE],
    naming: { entry: '[name].[ext]' },
    target: 'bun',
    // Parsed at build time: the server starts in a third of the time, for a few more megabytes of executable.
    bytecode: true,
    format: 'esm',
    compile: { outfile, assets: [clientBase, publicDir].filter(dir => existsSync(dir)) },
    // The production code of the app and its packages, as `NODE_ENV=production` gives a server started with Bun.
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    // Stylesheets reach pages through the client build, already embedded.
    plugins: [...configPlugins, withoutStyles(), withoutCompiler(), kay({ target: 'ssr', root, cacheDir: join(root, '.kay', 'cache'), settings: config.settings }), ...config.plugins ?? []],
  })

  if (!build.success)
    throw new AggregateError(build.logs, 'kay: compiling the server failed')

  return outfile
}

// Every module a route renders or runs: its page, layouts, special pages and guards.
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
    for (const file of [...route.layouts, route.file])
      files.add(file)

    addSpecial(route.special)

    for (const guard of route.guards) {
      files.add(guard.file)
      addSpecial(guard.special)
    }
  }

  addSpecial(fallback)

  return files
}

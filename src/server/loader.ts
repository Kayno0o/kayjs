import type { BunPlugin, OnLoadArgs, OnLoadResult, PluginBuilder } from 'bun'
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { plugin } from 'bun'
import { underKayDev } from '../build/assets'
import { SCRIPT_FILE, scriptLoader } from '../build/files'
import { loadConfig } from '../config'
import { projectPaths } from '../project'

interface Load {
  filter: RegExp
  namespace: string | undefined
  callback: (args: OnLoadArgs) => OnLoadResult | Promise<OnLoadResult>
}

interface Project {
  root: string
  // The root, and its real path when it is linked: Bun names a module by the latter.
  prefixes: string[]
  settings: string
  // `early` when `kay dev` registered it ahead of the entry, guessing the project from the working directory and its `kay.config.ts`.
  early: boolean
  ready: Promise<void>
  // What its plugin registered to load.
  loads: Load[]
}

// Every project this process loads `.kay` modules of, by root. Each registers a plugin of its own, as Bun cannot take one back.
const projects = new Map<string, Project>()
// The project registered last.
let current: Project | undefined

// The project that owns the modules under no project's root, such as a library linked from elsewhere: the one this process serves, not a fixture registered after it.
function fallback(): Project | undefined {
  return [...projects.values()].find(project => !project.early) ?? current
}

// A module of a name the plugins make up, such as an icon, is registered once and read from the current project.
type Virtual = () => { contents: string, loader: 'js' }
const virtualModules = new Map<string, Map<Project, Virtual>>()

function prefixesOf(root: string): string[] {
  return [...new Set([root, realpathSync(root)])].map(path => path.endsWith(sep) ? path : path + sep)
}

// The deepest project whose root holds the file, so an app nested in a guessed root loads as itself.
function ownerOf(path: string): Project | undefined {
  let owner: Project | undefined
  let depth = -1

  for (const project of projects.values()) {
    for (const prefix of project.prefixes) {
      if (path.startsWith(prefix) && prefix.length > depth) {
        owner = project
        depth = prefix.length
      }
    }
  }

  return owner ?? fallback()
}

// Bun runs the first callback whose filter matches and wants an object from it, so each callback a project's plugin registers hands the file to the callback of the project owning it, which a project's plugin registered for the same kind of file.
// A library's file under another project's root, such as one linked into a fixture below the checkout, loads for that root's project, and one under no root for the project this process serves: Bun keeps the first compile of a file, so two projects cannot differ on one shared library file.
// A shared file the owner has no callback for, such as a linked library's settings module under a project setting none, loads as it is.
function scoped(project: Project, inner: BunPlugin): BunPlugin {
  return {
    name: inner.name,
    async setup(build) {
      const view = {
        onStart: () => undefined,
        onEnd: () => undefined,
        config: build.config,
        onResolve: build.onResolve.bind(build),
        onLoad: (options: { filter: RegExp, namespace?: string }, callback: Load['callback']) => {
          project.loads.push({ filter: options.filter, namespace: options.namespace, callback })

          return build.onLoad(options, async (args) => {
            const owner = ownerOf(args.path)
            const load = owner?.loads.find(one => one.namespace === options.namespace && one.filter.test(args.path))

            if (load !== undefined)
              return load.callback(args)

            return owner !== project && SCRIPT_FILE.test(args.path) ? { contents: await Bun.file(args.path).text(), loader: scriptLoader(args.path) } : callback(args)
          })
        },
        module: (name: string, callback: Virtual) => {
          const callbacks = virtualModules.get(name) ?? new Map<Project, Virtual>()

          callbacks.set(project, callback)

          if (!virtualModules.has(name)) {
            virtualModules.set(name, callbacks)
            build.module(name, () => (callbacks.get(fallback()!) ?? [...callbacks.values()][0]!)())
          }
        },
      } as unknown as PluginBuilder

      await inner.setup(view)
    },
  }
}

// Lets this process import `.kay` files as server modules. Each project root loads its own files, with its own library settings, so a process can load several; a module is compiled once, whichever project asks for it again.
// Without `settings`, the project's `kay.config.ts` gives them, so whichever caller registers first renders libraries as the app configured them.
// Under `kay dev`, every element carries its source position for its inspector.
export async function registerLoader(root: string, settings?: Record<string, string>): Promise<void> {
  const config = await loadConfig(root)
  const chosen = settings ?? config.settings ?? {}
  const key = JSON.stringify(Object.entries(chosen).sort(([a], [b]) => a.localeCompare(b)))
  const at = resolve(root)
  let known = projects.get(at)

  if (known?.early === true) {
    const guess = known

    await guess.ready

    // A concurrent call may have settled the guess already.
    // `pages()` names other settings than `kay dev` guessed: the loader starts over with them, for the modules still to load.
    if (projects.get(at) === guess) {
      if (guess.settings !== key)
        projects.delete(at)
      else
        guess.early = false
    }

    known = projects.get(at)
  }

  if (known !== undefined && known.settings !== key) {
    throw new Error(`kay: the .kay loader is registered for ${at} with other library settings than ${JSON.stringify(chosen)}; one project renders libraries with one set`)
  }

  // A guess at the working directory gives way once the app names another project: no module of its own was waiting on it.
  for (const [other, project] of projects) {
    if (project.early && other !== at)
      projects.delete(other)
  }

  if (!projects.has(at)) {
    const project: Project = { root: at, prefixes: prefixesOf(at), settings: key, early: false, ready: Promise.resolve(), loads: [] }

    projects.set(at, project)
    project.ready = register(project, chosen, config.images?.placeholder)
  }

  current = projects.get(at)

  await current!.ready
}

// Whether a project of this root registered its loader in this process.
export function loaderLoaded(root: string): boolean {
  return projects.has(resolve(root))
}

// The project this process serves, once one is settled: `kay dev`'s early guess may still change.
export function loaderRoot(): string | undefined {
  const [first] = projects.values()

  return first?.early === false ? first.root : undefined
}

// For `kay dev`: what the entry imports before it calls `pages()`, such as a mailer rendering `.kay` mails, loads as the app's pages do.
export async function registerEarlyLoader(root: string): Promise<void> {
  await registerLoader(root)

  projects.get(resolve(root))!.early = true
}

async function register(project: Project, settings: Record<string, string>, placeholder: false | undefined): Promise<void> {
  const { kay } = await import('../build/plugin')

  await plugin(scoped(project, kay({ target: 'ssr', root: project.root, cacheDir: projectPaths(project.root).cache, settings, placeholder, inspect: underKayDev() })))
}

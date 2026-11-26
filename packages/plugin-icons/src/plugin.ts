/// <reference path="./ambient.d.ts" />
// The build side of @kayjs/icons: resolves `~icons/<set>/<name>` imports to inline SVG data at compile time, and adds `kay icons-find`.
// The reference above types those imports in every app registering icons() in kay.config.ts.

import type { BunPlugin } from 'bun'
import type { KayPlugin } from '@kayjs/kay/config'
import type { IconLookup } from './diagnose'
import type { IconSet } from './types'
import type { SvgDirSet } from './svg-dir'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { definePlugin } from '@kayjs/kay/config'
import { iconData } from './icon-data'
import { iconProblem } from './diagnose'
import { iconsFind } from './find'
import { installedPrefixes, isSetPrefix, setFile } from './sets'
import { readSvgDir } from './svg-dir'

const ICON_SPEC_RE = /^~icons\/([^/]+)\/(.+)$/
const SEARCH_ENTRY_RE = /^@kayjs\/icons\/search$/
const ICON_IMPORT_RE = /\b(?:from|import)\s*\(?\s*(['"])(~icons\/[^/'"]+\/[^'"]+)\1/g
const SELF_CLOSING_RE = /<([a-z][\w:-]*)([^<>]*?)\s*\/>/gi
const LOCAL_DIR = 'src/icons'

const transpilers = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }) }

// The ~icons specifiers a file imports or loads with import(), leaving out one only spelled in a string or a comment. A file that does not parse is left to the typecheck.
function importedIcons(code: string, file: string): Set<string> {
  try {
    const imports = transpilers[file.endsWith('.tsx') ? 'tsx' : 'ts'].scanImports(code)
    return new Set(imports.map(i => i.path).filter(path => path.startsWith('~icons/')))
  }
  catch {
    return new Set()
  }
}

// Spells `<path d="…"/>` as `<path d="…"></path>`, the way a browser serializes SVG, so hydrating an island finds the server's body unchanged and keeps its nodes.
function withEndTags(body: string): string {
  return body.replace(SELF_CLOSING_RE, '<$1$2></$1>')
}

export interface IconsPluginOptions {
  /** Optional preloaded custom icon sets keyed by prefix (e.g. `{ custom: mySet }`). */
  sets?: Record<string, IconSet> | undefined
  /** Folders of `.svg` files read as sets, keyed by prefix, relative to the app root (e.g. `{ brand: 'assets/brand' }`). `src/icons` is the set `local` unless named here. */
  dirs?: Record<string, string> | undefined
}

interface PluginLookup extends IconLookup {
  /** Each folder set's absolute folder, keyed by prefix. */
  dirs: Map<string, string>
  /** The folder set of `prefix`, with the files that are not icons. */
  dirSet: (prefix: string) => Promise<SvgDirSet | undefined>
}

function svgDirs(root: string, dirs: Record<string, string> = {}): Map<string, string> {
  const local = resolve(root, LOCAL_DIR)
  const named = Object.entries(dirs).map(([prefix, dir]): [string, string] => [prefix, resolve(root, dir)])
  return new Map(named.some(([, dir]) => dir === local) ? named : [['local', local], ...named])
}

function lineAndColumn(code: string, offset: number): string {
  const before = code.slice(0, offset).split('\n')
  return `${before.length}:${before.at(-1)!.length + 1}`
}

export function icons(options: IconsPluginOptions = {}): KayPlugin {
  // The in-flight read of each set, so icons loaded in parallel parse their set once; a set not installed is looked for again next time.
  const cache = new Map<string, Promise<IconSet | undefined>>(Object.entries(options.sets ?? {}).map(([prefix, set]) => [prefix, Promise.resolve(set)]))
  const installedSet = (root: string, prefix: string): Promise<IconSet | undefined> => {
    let set = cache.get(prefix)
    if (set === undefined) {
      const file = setFile(prefix, root)
      if (file === undefined)
        return Promise.resolve(undefined)
      set = Bun.file(file).json() as Promise<IconSet>
      cache.set(prefix, set)
    }
    return set
  }
  // Folder sets are read again by each build, so `kay dev` sees an edited file.
  const lookupIn = (root: string): PluginLookup => {
    const dirs = svgDirs(root, options.dirs)
    if (options.sets?.local !== undefined && options.dirs?.local === undefined)
      dirs.delete('local')
    const dirSets = new Map<string, Promise<SvgDirSet | undefined>>()
    const dirSet = (prefix: string): Promise<SvgDirSet | undefined> => {
      let read = dirSets.get(prefix)
      if (read === undefined) {
        const dir = dirs.get(prefix)
        read = dir === undefined ? Promise.resolve(undefined) : readSvgDir(prefix, dir)
        dirSets.set(prefix, read)
      }
      return read
    }
    return {
      dirs,
      dirSet,
      set: async prefix => dirs.has(prefix) ? (await dirSet(prefix))?.set : await installedSet(root, prefix),
      prefixes: () => [...new Set([...Object.keys(options.sets ?? {}), ...[...dirs].filter(([, dir]) => existsSync(dir)).map(([prefix]) => prefix), ...installedPrefixes(root)])],
    }
  }

  // Why the icon `name` of a folder set cannot load, naming its file; undefined when it is no folder set or its file is fine.
  async function fileProblem(lookup: PluginLookup, root: string, prefix: string, name: string): Promise<{ file: string, problem: string } | undefined> {
    const problem = (await lookup.dirSet(prefix))?.problems.get(name)
    return problem === undefined ? undefined : { file: relative(root, join(lookup.dirs.get(prefix)!, `${name}.svg`)), problem }
  }

  return definePlugin({
    name: '@kayjs/icons',
    async check(ctx) {
      const lookup = lookupIn(ctx.root)
      for (const [prefix, dir] of Object.entries(options.dirs ?? {})) {
        if (!isSetPrefix(prefix))
          ctx.error(`@kayjs/icons: "${prefix}" in icons({ dirs }) is not an icon set name: name it in lowercase words joined by dashes, such as brand.`)
        else if (!existsSync(lookup.dirs.get(prefix)!))
          ctx.error(`@kayjs/icons: icons({ dirs }) reads the set "${prefix}" from ${dir}, which does not exist.`)
      }
      for (const prefix of lookup.dirs.keys()) {
        for (const [name, problem] of (await lookup.dirSet(prefix))?.problems ?? [])
          ctx.error(`${relative(ctx.root, join(lookup.dirs.get(prefix)!, `${name}.svg`))}:1:1: error: @kayjs/icons: this file ${problem}.`)
      }
      for (const file of new Bun.Glob('src/**/*.{ts,tsx,mts}').scanSync({ cwd: ctx.root })) {
        const code = await Bun.file(join(ctx.root, file)).text()
        const imported = importedIcons(code, file)
        for (const found of code.matchAll(ICON_IMPORT_RE)) {
          // The regex finds where a specifier is spelled; only one the file really imports is checked, once.
          if (!imported.delete(found[2]!))
            continue
          const [, prefix, name] = ICON_SPEC_RE.exec(found[2]!)!
          // A broken file is reported once above, not at each import.
          if (await fileProblem(lookup, ctx.root, prefix!, name!) !== undefined)
            continue
          const problem = await iconProblem(prefix!, name!, '', lookup)
          if (problem !== undefined)
            ctx.error(`${file}:${lineAndColumn(code, found.index + found[0].length - found[2]!.length - 2)}: error: @kayjs/icons: ${problem}`)
        }
      }
    },
    watchPaths: root => [...lookupIn(root).dirs.values()],
    bunPlugins: ({ root, target }): BunPlugin[] => [{
      name: 'kayjs-icons',
      setup(b) {
        const lookup = lookupIn(root)
        if (target === 'client') {
          b.onResolve({ filter: SEARCH_ENTRY_RE }, (args) => {
            console.warn(`@kayjs/icons: ${relative(root, args.importer)} imports @kayjs/icons/search into an island, which ships its 1.7 MB word table to the browser. Search on the server instead, in a route or an action.`)
            return undefined
          })
        }
        // The first file importing each icon, for an error to name it.
        const importers = new Map<string, string>()
        b.onResolve({ filter: ICON_SPEC_RE }, (args) => {
          if (!importers.has(args.path))
            importers.set(args.path, relative(root, args.importer))
          return { path: args.path, namespace: 'kay-icon' }
        })

        b.onLoad({ filter: /.*/, namespace: 'kay-icon' }, async (args) => {
          const [, prefix, name] = ICON_SPEC_RE.exec(args.path)!
          const set = await lookup.set(prefix!)
          const data = set === undefined ? undefined : iconData(set, name!)
          if (data === undefined) {
            const broken = await fileProblem(lookup, root, prefix!, name!)
            if (broken !== undefined)
              throw new Error(`@kayjs/icons: ${broken.file}, imported by ${importers.get(args.path)}, ${broken.problem}.`)
            throw new Error(`@kayjs/icons: ${await iconProblem(prefix!, name!, `, imported by ${importers.get(args.path)}`, lookup)}`)
          }

          return {
            contents: `export default ${JSON.stringify(target === 'client' ? { ...data, body: withEndTags(data.body) } : data)};\n`,
            loader: 'js',
          }
        })
      },
    }],
    commands: {
      'icons-find': async (args, root) => await iconsFind(args, lookupIn(root)),
    },
  })
}

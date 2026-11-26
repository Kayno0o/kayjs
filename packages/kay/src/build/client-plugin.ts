// The Bun plugin of the client build: kay specifiers, action stubs, compiled islands, and imports of the `@kayjs/kay` barrel pointed at the module holding each name.

import type { BunPlugin } from 'bun'
import type { BuildCache, ModuleGraph } from './graph'
import type { ActionsByFile } from './islands'
import { compileDom } from '../compiler/index'
import { SERVER_ONLY_FILTER } from '../compiler/server-only'
import { relPosix } from './files'
import { resolveKaySpecifier } from './resolve'

export const KAY_SPECIFIER_FILTER = /^@kayjs\/kay(?:\/.*)?$/
export const TS_FILTER = /\.(?:ts|tsx)$/
const BARREL_IMPORT_RE = /^([ \t]*)import\s*\{([^}]*)\}\s*from\s*(['"])@kayjs\/kay\3;?/gm
const SPECIFIER_RE = /^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/

export interface ClientTransforms {
  active: boolean
  key: string
  apply: (code: string, id: string, target: 'server' | 'client') => string
}

export interface ClientPluginEnv {
  root: string
  graph: ModuleGraph
  cache: BuildCache | undefined
  actionsByFile: ActionsByFile
  transforms: ClientTransforms
  /** Collects each server-only import a browser file makes, reported once the build ends. */
  leaks: Set<string>
}

/**
 * Rewrites `import { a, b } from '@kayjs/kay'` to import each name from the module declaring it.
 * Through the barrel every island reaches every module it re-exports, and Bun then places a module only some islands use (the action runtime) in the shared chunk in one build and in the island's own chunk in the next (#3598).
 */
export function directKayImports(code: string, graph: ModuleGraph): string {
  if (!code.includes('@kayjs/kay'))
    return code
  const barrel = resolveKaySpecifier('@kayjs/kay')!
  return code.replace(BARREL_IMPORT_RE, (statement, indent: string, list: string) => {
    const byFile = new Map<string, string[]>()
    const kept: string[] = []
    for (const raw of list.split(',')) {
      const spec = raw.trim()
      if (spec === '')
        continue
      const match = SPECIFIER_RE.exec(spec)
      const target = match !== null && match[1] === undefined ? graph.exportTarget(barrel, match[2]!) : undefined
      if (target === undefined || target.file === barrel) {
        kept.push(spec)
        continue
      }
      const local = match![3] ?? match![2]!
      const names = byFile.get(target.file) ?? []
      names.push(target.exportName === local ? local : `${target.exportName} as ${local}`)
      byFile.set(target.file, names)
    }
    const lines = [...byFile].map(([file, names]) => `import { ${names.join(', ')} } from ${JSON.stringify(file)};`)
    if (kept.length > 0)
      lines.push(`import { ${kept.join(', ')} } from '@kayjs/kay';`)
    // Same line count, so later positions in the module stay where they were.
    return `${indent}${lines.join(' ')}${'\n'.repeat(statement.split('\n').length - 1)}`
  })
}

export function clientPlugin(env: ClientPluginEnv): BunPlugin {
  const { root, graph, cache, actionsByFile, transforms, leaks } = env
  return {
    name: 'kay-v2-client',
    setup(b) {
      // Bun swaps node built-ins for empty shims in a browser build, so a server-only import would ship silently.
      b.onResolve({ filter: SERVER_ONLY_FILTER }, (args) => {
        if (!args.importer.includes('/node_modules/'))
          leaks.add(`${relPosix(root, args.importer)} imports server-only module "${args.path}"`)
        return undefined
      })
      b.onResolve({ filter: KAY_SPECIFIER_FILTER }, (args) => {
        const resolved = resolveKaySpecifier(args.path)
        return resolved !== undefined ? { path: resolved } : undefined
      })
      b.onLoad({ filter: TS_FILTER }, (args) => {
        const actions = actionsByFile.get(args.path)
        if (actions !== undefined && !graph.analyses.get(args.path)?.isInteractive) {
          const lines = [`import { actionStub } from '@kayjs/kay/internal/action';`]
          for (const a of actions)
            lines.push(`export const ${a.exportName} = actionStub(${JSON.stringify(a.url)});`)
          return { contents: `${lines.join('\n')}\n`, loader: 'ts' }
        }

        if (!args.path.endsWith('.tsx')) {
          const raw = graph.source(args.path)
          const own = transforms.active && !args.path.includes('/node_modules/') ? transforms.apply(raw, args.path, 'client') : raw
          const direct = directKayImports(own, graph)
          return direct !== raw ? { contents: direct, loader: 'ts' } : undefined
        }

        const stamp = graph.stamp(args.path)
        const cachedDom = stamp !== undefined ? cache?.domCompiled.get(args.path) : undefined
        if (cachedDom !== undefined && cachedDom.mtimeMs === stamp!.mtimeMs && cachedDom.size === stamp!.size && (cachedDom.key ?? '') === transforms.key)
          return { contents: cachedDom.code, loader: 'tsx' }
        const compiled = directKayImports(transforms.apply(compileDom(args.path, graph.source(args.path), { analysis: graph.analyses.get(args.path) }).code, args.path, 'client'), graph)
        if (cache !== undefined && stamp !== undefined)
          cache.domCompiled.set(args.path, { mtimeMs: stamp.mtimeMs, size: stamp.size, key: transforms.key, code: compiled })
        return { contents: compiled, loader: 'tsx' }
      })
    },
  }
}

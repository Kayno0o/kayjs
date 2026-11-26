// The Bun plugin of the client build: kay specifiers, action stubs, compiled islands, and imports of the `@kayjs/kay` barrel pointed at the module holding each name.

import type { BunPlugin } from 'bun'
import type { BuildCache, ModuleGraph } from './graph'
import type { ActionsByFile } from './islands'
import { parseSync } from 'oxc-parser'
import { compileDom } from '../compiler/index'
import { SERVER_ONLY_FILTER } from '../compiler/server-only'
import { relPosix } from './files'
import { resolveKaySpecifier } from './resolve'

export const KAY_SPECIFIER_FILTER = /^@kayjs\/kay(?:\/.*)?$/
export const TS_FILTER = /\.(?:ts|tsx)$/
const TS_LANG_RE = /\.[cm]?ts$/i

export interface ClientTransforms {
  active: boolean
  key: string
  /** The first hook that threw, named, rethrown once the build is done. */
  failure: Error | undefined
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
 * Rewrites top-level `import { a, b } from '@kayjs/kay'` statements to import each name from the module declaring it.
 * Through the barrel every island reaches every module it re-exports, and Bun then places a module only some islands use (the action runtime) in the shared chunk in one build and in the island's own chunk in the next (#3598).
 */
export function directKayImports(code: string, graph: ModuleGraph, filename = 'module.tsx'): string {
  if (!code.includes('@kayjs/kay'))
    return code
  const barrel = resolveKaySpecifier('@kayjs/kay')!
  const lang = TS_LANG_RE.test(filename) ? 'ts' : 'tsx'
  const parsed = parseSync(filename, code, { lang, sourceType: 'module' })
  if (parsed.errors.length > 0)
    return code

  const edits: { start: number, end: number, text: string }[] = []
  for (const stmt of parsed.program.body) {
    if (stmt.type !== 'ImportDeclaration' || stmt.importKind === 'type' || stmt.source.value !== '@kayjs/kay')
      continue
    if (stmt.specifiers.length === 0 || stmt.specifiers.some(s => s.type !== 'ImportSpecifier'))
      continue

    const byFile = new Map<string, string[]>()
    const kept: string[] = []
    for (const spec of stmt.specifiers) {
      if (spec.type !== 'ImportSpecifier')
        continue
      const imported = spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value
      const importedRaw = spec.imported.type === 'Identifier' ? imported : JSON.stringify(imported)
      const local = spec.local.name
      const rawSpec = imported === local && spec.imported.type === 'Identifier' ? local : `${importedRaw} as ${local}`
      if (spec.importKind === 'type') {
        kept.push(`type ${rawSpec}`)
        continue
      }
      const target = graph.exportTarget(barrel, imported)
      if (target.file === barrel) {
        kept.push(rawSpec)
        continue
      }
      const names = byFile.get(target.file) ?? []
      names.push(target.exportName === local ? local : `${target.exportName} as ${local}`)
      byFile.set(target.file, names)
    }
    if (byFile.size === 0)
      continue

    const lines = [...byFile].map(([file, names]) => `import { ${names.join(', ')} } from ${JSON.stringify(file)};`)
    if (kept.length > 0)
      lines.push(`import { ${kept.join(', ')} } from '@kayjs/kay';`)
    const stmtText = code.slice(stmt.start, stmt.end)
    // Same line count, so later positions in the module stay where they were.
    edits.push({ start: stmt.start, end: stmt.end, text: `${lines.join(' ')}${'\n'.repeat(stmtText.split('\n').length - 1)}` })
  }

  if (edits.length === 0)
    return code
  let out = ''
  let cursor = 0
  for (const edit of edits) {
    out += code.slice(cursor, edit.start) + edit.text
    cursor = edit.end
  }
  return out + code.slice(cursor)
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
        if (actions !== undefined) {
          if (graph.analyses.get(args.path)?.isInteractive) {
            leaks.add(`${relPosix(root, args.path)} exports server actions and uses browser interactivity (move actions to a separate non-interactive file)`)
            return undefined
          }
          const lines = [`import { actionStub } from '@kayjs/kay/internal/action';`]
          for (const a of actions)
            lines.push(`export const ${a.exportName} = actionStub(${JSON.stringify(a.url)});`)
          return { contents: `${lines.join('\n')}\n`, loader: 'ts' }
        }

        if (!args.path.endsWith('.tsx')) {
          const raw = graph.source(args.path)
          const own = transforms.active && !args.path.includes('/node_modules/') ? transforms.apply(raw, args.path, 'client') : raw
          const direct = directKayImports(own, graph, args.path)
          return direct !== raw ? { contents: direct, loader: 'ts' } : undefined
        }

        const stamp = graph.stamp(args.path)
        const cachedDom = stamp !== undefined ? cache?.domCompiled.get(args.path) : undefined
        if (cachedDom !== undefined && cachedDom.mtimeMs === stamp!.mtimeMs && cachedDom.size === stamp!.size && (cachedDom.key ?? '') === transforms.key)
          return { contents: cachedDom.code, loader: 'tsx' }
        const compiled = directKayImports(transforms.apply(compileDom(args.path, graph.source(args.path), { analysis: graph.analyses.get(args.path) }).code, args.path, 'client'), graph, args.path)
        if (cache !== undefined && stamp !== undefined)
          cache.domCompiled.set(args.path, { mtimeMs: stamp.mtimeMs, size: stamp.size, key: transforms.key, code: compiled })
        return { contents: compiled, loader: 'tsx' }
      })
    },
  }
}

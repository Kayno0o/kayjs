// `kay check [dir]`: validates routes, Kay compiler & island rules, config, and runs TypeScript type-checking.

import type { AstNode, ModuleAnalysis } from '../compiler/analyze'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { isTsFile, relPosix, walkFiles } from '../build/files'
import { ModuleGraph } from '../build/graph'
import { fileToRoutePath, normalizeRoutePattern, routeExportProblem } from '../build/routes'
import { analyzeModule, walk } from '../compiler/analyze'
import { readsPrivateEnv, SERVER_ONLY_MODULES } from '../compiler/server-only'
import { loadConfig } from '../plugins/index'

export interface CheckResult {
  ok: boolean
  checkedFiles: number
  errors: string[]
  warnings: string[]
}

const SERIALIZABLE_NEW_CTORS = new Set(['Date', 'Map', 'Set', 'URL', 'RegExp'])

function walkTsFiles(dir: string): string[] {
  return walkFiles(dir, {
    skipDir: name => name === 'node_modules' || name === 'dist' || name.startsWith('.'),
    keep: entry => isTsFile(entry.name),
  })
}

// A module outside the scanned folders (a workspace or npm package an island imports) is analysed when first reached. One that fails to parse is not parsed again.
function analysisOf(file: string, analyses: Map<string, ModuleAnalysis>, unparsable: Set<string>): ModuleAnalysis | undefined {
  if (!analyses.has(file) && !unparsable.has(file) && isTsFile(file)) {
    try {
      analyses.set(file, analyzeModule(file, readFileSync(file, 'utf8')))
    }
    catch {
      unparsable.add(file)
    }
  }
  return analyses.get(file)
}

// Walks the local imports of an island the way the client build follows them: a module that only declares actions is stubbed there, so its imports stop the walk.
function checkIslandReach(island: string, root: string, graph: ModuleGraph, unparsable: Set<string>, reported: Set<string>, errors: string[]): void {
  const islandRel = relPosix(root, island)
  const seen = new Set<string>()
  const stack = [island]
  while (stack.length > 0) {
    const file = stack.pop()!
    if (seen.has(file))
      continue
    seen.add(file)
    // Like the build, an npm package's own imports are its business: only project and workspace files are checked.
    if (file.includes('/node_modules/'))
      continue
    const analysis = analysisOf(file, graph.analyses, unparsable)
    if (analysis === undefined || (file !== island && !analysis.isInteractive && analysis.exportedActions.length > 0))
      continue
    const rel = relPosix(root, file)
    const report = (key: string, message: string): void => {
      if (reported.has(`${file}\0${key}`))
        return
      reported.add(`${file}\0${key}`)
      errors.push(message)
    }
    for (const source of [...analysis.imports.map(i => i.source), ...analysis.reexports.map(r => r.source)]) {
      if (SERVER_ONLY_MODULES.has(source)) {
        report(source, file === island
          ? `kay check: ${rel}: interactive island imports server-only module "${source}". Move server logic to a server action or async server component.`
          : `kay check: ${rel}: imports server-only module "${source}" and is reachable from the island in ${islandRel}. Move server logic to a server action or async server component.`)
        continue
      }
      const target = graph.resolve(file, source)
      if (target !== undefined)
        stack.push(target)
    }
    if (readsPrivateEnv(analysis.program))
      report('process.env', `kay check: ${rel}: reads process.env and is reachable from the island in ${islandRel}. Only process.env.PUBLIC_* reaches the browser.`)
  }
}

export async function checkProject(rootDir: string, options: { skipTypecheck?: boolean } = {}): Promise<CheckResult> {
  const root = resolve(rootDir)
  const errors: string[] = []

  // 1. Validate kay.config.ts
  let routesDir = resolve(root, 'src/routes')
  let plugins: Awaited<ReturnType<typeof loadConfig>>['plugins'] = []
  try {
    const cfg = await loadConfig(root)
    plugins = cfg.plugins ?? []
    if (cfg.routesDir !== undefined)
      routesDir = resolve(root, cfg.routesDir)
  }
  catch (err) {
    errors.push(`kay.config.ts: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. Validate routesDir exists
  if (!existsSync(routesDir))
    errors.push(`missing routes directory: ${relative(root, routesDir) || routesDir}`)

  // 3. Parse & run Kay static compiler analysis across src/
  const srcDir = resolve(root, 'src')
  const files = walkTsFiles(existsSync(srcDir) ? srcDir : routesDir)
  const graph = new ModuleGraph()
  const { analyses } = graph
  const unparsable = new Set<string>()

  const warnings: string[] = []
  for (const file of files) {
    try {
      const analysis = analyzeModule(file, readFileSync(file, 'utf8'))
      analyses.set(file, analysis)
      warnings.push(...analysis.warnings)
    }
    catch (err) {
      unparsable.add(file)
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  // 3b. Static guardrails: server-only imports in islands, non-serializable island props, route conflicts, missing paths()
  const seenRoutes = new Map<string, string>()
  const reported = new Set<string>()

  // A snapshot: the guardrails analyse packages they reach, and those are not checked as project files.
  for (const [file, analysis] of [...analyses]) {
    const rel = relPosix(root, file)

    // Guardrail 1: server-only imports and private env reads in an island or any module it imports
    if (analysis.isInteractive)
      checkIslandReach(file, root, graph, unparsable, reported, errors)

    // Guardrail 2: non-serializable props (functions / unsupported class instances) passed from static server code into an island
    if (!analysis.isInteractive && file.endsWith('.tsx')) {
      const islandTags = new Set<string>()
      for (const imp of analysis.imports) {
        const target = graph.resolve(file, imp.source)
        if (target === undefined)
          continue
        const targetAnalysis = analysisOf(target, analyses, unparsable)
        if (targetAnalysis?.isInteractive) {
          for (const spec of imp.specifiers)
            islandTags.add(spec.local)
        }
      }

      if (islandTags.size > 0) {
        walk(analysis.program, (node: AstNode) => {
          if (node.type !== 'JSXOpeningElement' || node.name?.type !== 'JSXIdentifier')
            return
          const tag = node.name.name as string
          if (!islandTags.has(tag))
            return
          for (const attr of (node.attributes ?? []) as AstNode[]) {
            if (attr.type !== 'JSXAttribute' || attr.name?.type !== 'JSXIdentifier')
              continue
            const attrName = attr.name.name as string
            if (attrName === 'key' || attrName === '$hydrate')
              continue
            if (attr.value?.type !== 'JSXExpressionContainer')
              continue
            const expr = attr.value.expression as AstNode | undefined
            if (expr === undefined)
              continue
            if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') {
              errors.push(
                `kay check: ${rel}: cannot pass function prop "${attrName}" from a server component into island <${tag}>. Define the handler inside the island or pass serializable data.`,
              )
            }
            else if (expr.type === 'NewExpression' && expr.callee?.type === 'Identifier' && !SERIALIZABLE_NEW_CTORS.has(expr.callee.name as string)) {
              errors.push(
                `kay check: ${rel}: cannot pass non-serializable \`new ${expr.callee.name}()\` prop "${attrName}" into island <${tag}>.`,
              )
            }
          }
        })
      }
    }

    // Route-specific guardrails
    const relFromRoutes = relative(routesDir, file)
    const isRouteFile = !relFromRoutes.startsWith('..') && !basename(file).startsWith('_')
    if (isRouteFile) {
      const conflictKey = normalizeRoutePattern(fileToRoutePath(routesDir, file))
      const prev = seenRoutes.get(conflictKey)
      if (prev !== undefined) {
        errors.push(`kay check: conflicting routes "${prev}" and "${rel}" both match "${conflictKey}".`)
      }
      else {
        seenRoutes.set(conflictKey, rel)
      }

      const problem = routeExportProblem(analysis, rel)
      if (problem !== undefined)
        errors.push(`kay check: ${problem}`)

      // Guardrail 4: dynamic prerender = true route missing paths()
      if (analysis.hasPrerender && (conflictKey.includes(':') || conflictKey.includes('*')) && !analysis.hasPaths) {
        errors.push(`kay check: ${rel}: dynamic route exports \`prerender = true\` without exporting \`paths()\`.`)
      }
    }
  }

  // 3c. Run plugin check(ctx) hooks
  if (plugins && plugins.length > 0) {
    const pluginCtx = {
      root,
      routesDir,
      error(message: string) {
        errors.push(message)
      },
    }
    for (const plugin of plugins) {
      if (plugin.check !== undefined) {
        try {
          await plugin.check(pluginCtx)
        }
        catch (err) {
          errors.push(`${plugin.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  // 4. Run TypeScript check (`tsgo` preferred, fallback to `tsc`) when tsconfig.json exists
  const tsconfigPath = join(root, 'tsconfig.json')
  if (!options.skipTypecheck && existsSync(tsconfigPath)) {
    const candidates = [
      join(root, 'node_modules/.bin/tsgo'),
      join(root, 'node_modules/.bin/tsc'),
      'tsgo',
      'tsc',
    ]
    let bin: string | undefined
    for (const c of candidates) {
      if (c.includes('/') ? existsSync(c) : Bun.which(c) !== null) {
        bin = c
        break
      }
    }
    if (bin !== undefined) {
      const proc = Bun.spawnSync([bin, '--noEmit', '-p', tsconfigPath], { cwd: root })
      if (proc.exitCode !== 0) {
        const out = (proc.stdout.toString() + proc.stderr.toString()).trim()
        errors.push(out || `${bin} exited with code ${proc.exitCode}`)
      }
    }
  }

  return { ok: errors.length === 0, checkedFiles: files.length, errors, warnings }
}

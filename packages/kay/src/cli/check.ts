// `kay check [dir]`: validates routes, Kay compiler & island rules (unified with `kay build`), config, and TypeScript types.

import type { ModuleAnalysis } from '../compiler/analyze'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { isTsFile, relPosix, walkFiles, walkRoutes } from '../build/files'
import { ModuleGraph } from '../build/graph'
import { fileToRoutePath, hasRouteHandlerExport, normalizeRoutePattern, routeExportProblemLocation, SPECIAL_ROUTE_FILES } from '../build/routes'
import { analyzeModule, walk } from '../compiler/analyze'
import { findPrivateEnvOffset, SERVER_ONLY_MODULES } from '../compiler/server-only'
import { DIAGNOSTIC_PREFIX_RE, formatDiagnostic, formatLoc, jsxTagName } from '../compiler/shared'
import { createAppContext, loadConfig, runWithAppContext } from '../plugins/index'

export interface CheckResult {
  ok: boolean
  checkedFiles: number
  errors: string[]
  warnings: string[]
}

const SERIALIZABLE_NEW_CTORS = new Set(['Date', 'Map', 'Set', 'URL', 'RegExp'])
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/

function walkTsFiles(dir: string): string[] {
  return walkFiles(dir, {
    skipDir: name => name === 'node_modules' || name === 'dist' || name.startsWith('.'),
    keep: entry => isTsFile(entry.name),
  })
}

function sourceOf(file: string, sources: Map<string, string>): string {
  let code = sources.get(file)
  if (code === undefined) {
    code = readFileSync(file, 'utf8')
    sources.set(file, code)
  }
  return code
}

function analysisOf(file: string, analyses: Map<string, ModuleAnalysis>, sources: Map<string, string>, unparsable: Set<string>): ModuleAnalysis | undefined {
  if (!analyses.has(file) && !unparsable.has(file) && isTsFile(file)) {
    try {
      analyses.set(file, analyzeModule(file, sourceOf(file, sources)))
    }
    catch {
      unparsable.add(file)
    }
  }
  return analyses.get(file)
}

function locOf(root: string, file: string, sources: Map<string, string>, offset = 0): string {
  const rel = relPosix(root, file)
  const code = sources.get(file)
  return code !== undefined ? formatLoc(rel, code, offset) : `${rel}:1:1`
}

function findExportedConstOffset(analysis: ModuleAnalysis, name: string): number {
  for (const stmt of analysis.program.body) {
    if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration?.type === 'VariableDeclaration') {
      for (const d of stmt.declaration.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === name)
          return d.start
      }
    }
  }
  return 0
}

function normalizeDiagnosticPath(root: string, file: string, message: string): string {
  const rel = relPosix(root, file)
  if (DIAGNOSTIC_PREFIX_RE.test(message)) {
    if (message.startsWith(`${file}:`))
      return `${rel}${message.slice(file.length)}`
    return message
  }
  return formatDiagnostic(`${rel}:1:1`, message)
}

// Walks the local imports of an island the way the client build follows them: a module that only declares actions is stubbed there, so its imports stop the walk.
function checkIslandReach(
  island: string,
  root: string,
  graph: ModuleGraph,
  sources: Map<string, string>,
  unparsable: Set<string>,
  reported: Set<string>,
  errors: string[],
): void {
  const islandRel = relPosix(root, island)
  const seen = new Set<string>()
  const stack = [island]
  while (stack.length > 0) {
    const file = stack.pop()!
    if (seen.has(file))
      continue
    seen.add(file)
    if (NODE_MODULES_RE.test(file))
      continue
    const analysis = analysisOf(file, graph.analyses, sources, unparsable)
    if (analysis === undefined || (file !== island && !analysis.isInteractive && analysis.exportedActions.length > 0))
      continue
    const report = (key: string, offset: number, message: string): void => {
      if (reported.has(`${file}\0${key}`))
        return
      reported.add(`${file}\0${key}`)
      errors.push(formatDiagnostic(locOf(root, file, sources, offset), message))
    }
    for (const imp of analysis.imports) {
      if (SERVER_ONLY_MODULES.has(imp.source)) {
        report(imp.source, imp.start, file === island
          ? `kay check: interactive island imports server-only module "${imp.source}". Move server logic to a server action or async server component.`
          : `kay check: imports server-only module "${imp.source}" and is reachable from the island in ${islandRel}. Move server logic to a server action or async server component.`)
        continue
      }
      const target = graph.resolve(file, imp.source)
      if (target !== undefined) {
        const targetAnalysis = analysisOf(target, graph.analyses, sources, unparsable)
        if (targetAnalysis !== undefined && !targetAnalysis.isInteractive && targetAnalysis.exportedActions.length > 0) {
          const missing = imp.specifiers.find(s => s.imported !== '*' && !targetAnalysis.exportedActions.includes(s.imported))
          if (missing !== undefined)
            report(`action-export:${target}:${missing.imported}`, imp.start, `kay check: imports non-action "${missing.imported}" from server action file ${relPosix(root, target)}. Move ${missing.imported} into a module without actions.`)
          continue
        }
        stack.push(target)
      }
    }
    for (const re of analysis.reexports) {
      if (SERVER_ONLY_MODULES.has(re.source)) {
        report(re.source, re.start, `kay check: re-exports from server-only module "${re.source}" and is reachable from the island in ${islandRel}.`)
        continue
      }
      const target = graph.resolve(file, re.source)
      if (target !== undefined)
        stack.push(target)
    }
    const envOffset = findPrivateEnvOffset(analysis.program)
    if (envOffset !== undefined)
      report('process.env', envOffset, `kay check: reads process.env and is reachable from the island in ${islandRel}. Only process.env.PUBLIC_* reaches the browser.`)
  }
}

export async function checkProject(rootDir: string, options: { skipTypecheck?: boolean } = {}): Promise<CheckResult> {
  const root = resolve(rootDir)
  const errors: string[] = []

  // 1. Validate kay.config.ts
  let routesDir = resolve(root, 'src/routes')
  let outDir = resolve(root, 'dist')
  let assetPrefix = '/_kay'
  let plugins: Awaited<ReturnType<typeof loadConfig>>['plugins'] = []
  try {
    const cfg = await loadConfig(root)
    plugins = cfg.plugins ?? []
    if (cfg.routesDir !== undefined)
      routesDir = resolve(root, cfg.routesDir)
    if (cfg.outDir !== undefined)
      outDir = resolve(root, cfg.outDir)
    if (cfg.assetPrefix !== undefined)
      assetPrefix = cfg.assetPrefix.replace(/\/$/, '')
  }
  catch (err) {
    errors.push(formatDiagnostic('kay.config.ts:1:1', err instanceof Error ? err.message : String(err)))
  }

  // 2. Validate routesDir exists
  if (!existsSync(routesDir)) {
    const relRoutes = relative(root, routesDir) || routesDir
    errors.push(formatDiagnostic(`${relRoutes.replace(/\\/g, '/')}:1:1`, `kay check: missing routes directory: ${relRoutes}`))
  }

  // 3. Parse & run Kay static compiler analysis across src/ AND custom routesDir
  const srcDir = resolve(root, 'src')
  const fileSet = new Set<string>()
  if (existsSync(srcDir)) {
    for (const f of walkTsFiles(srcDir))
      fileSet.add(f)
  }
  if (existsSync(routesDir)) {
    for (const f of walkTsFiles(routesDir))
      fileSet.add(f)
  }
  const files = [...fileSet].sort()
  const graph = new ModuleGraph()
  const { analyses } = graph
  const sources = new Map<string, string>()
  const unparsable = new Set<string>()

  const warnings: string[] = []
  for (const file of files) {
    try {
      const code = sourceOf(file, sources)
      const analysis = analyzeModule(file, code)
      analyses.set(file, analysis)
      warnings.push(...analysis.warnings)
    }
    catch (err) {
      unparsable.add(file)
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(normalizeDiagnosticPath(root, file, msg))
    }
  }

  // 3a. Promote components reading imported reactive state (same rule as `planIslands` in `kay build`)
  for (const [file, analysis] of [...analyses]) {
    if (!file.endsWith('.tsx') || analysis.isInteractive)
      continue
    for (const imp of analysis.imports) {
      const resolved = graph.resolve(file, imp.source)
      if (resolved === undefined || !isTsFile(resolved))
        continue
      const state = imp.specifiers.find((spec) => {
        if (analysis.jsxTags.has(spec.local))
          return false
        try {
          if (spec.imported === '*')
            return (analysisOf(resolved, analyses, sources, unparsable)?.stateExports.length ?? 0) > 0
          const target = graph.exportTarget(resolved, spec.imported)
          return analysisOf(target.file, analyses, sources, unparsable)?.stateExports.includes(target.exportName) === true
        }
        catch {
          return false
        }
      })
      if (state !== undefined) {
        const reason = `reads ${state.local} from '${imp.source}'`
        if (analysis.hasAsyncDefault)
          errors.push(formatDiagnostic(locOf(root, file, sources, imp.start), `kay check: async route component cannot use browser interactivity (${reason}).`))
        else
          analyses.set(file, { ...analysis, isInteractive: true, interactiveReason: reason, interactiveOffset: imp.start })
        break
      }
    }
  }

  // Exact route discovery matching `kay build` (`walkRoutes` skips `_components/` dirs, `.d.ts`, `.test.ts`)
  const routeFiles = existsSync(routesDir) ? walkRoutes(routesDir).sort() : []
  const routeFileSet = new Set(routeFiles)

  // 3b. Static guardrails: server-only imports in islands, non-serializable island props, special files, route conflicts, missing paths()
  const seenRoutes = new Map<string, string>()
  const reported = new Set<string>()

  for (const [file, analysis] of [...analyses]) {
    const rel = relPosix(root, file)

    // Special route files (`_layout.tsx`, `_error.tsx`, `_404.tsx`) cannot be interactive
    if (routeFileSet.has(file) && SPECIAL_ROUTE_FILES.has(basename(file)) && analysis.isInteractive) {
      errors.push(formatDiagnostic(
        locOf(root, file, sources, analysis.interactiveOffset ?? 0),
        `kay check: ${rel} uses browser interactivity (${analysis.interactiveReason}), but it renders on the server only. Move the interactive part into a component and render that component from ${rel}.`,
      ))
    }

    // Guardrail 1: server-only imports and private env reads in an island or any module it imports
    if (analysis.isInteractive)
      checkIslandReach(file, root, graph, sources, unparsable, reported, errors)

    // Guardrail 2: non-serializable props passed from static server code into an island (including barrels & namespaces)
    if (!analysis.isInteractive && file.endsWith('.tsx')) {
      const islandTags = new Set<string>()
      const islandNamespaces = new Map<string, string>() // localNs -> resolved file
      for (const imp of analysis.imports) {
        const resolved = graph.resolve(file, imp.source)
        if (resolved === undefined || !isTsFile(resolved))
          continue
        for (const spec of imp.specifiers) {
          if (spec.imported === '*') {
            islandNamespaces.set(spec.local, resolved)
            continue
          }
          try {
            const target = graph.exportTarget(resolved, spec.imported)
            if (analysisOf(target.file, analyses, sources, unparsable)?.isInteractive)
              islandTags.add(spec.local)
          }
          catch {}
        }
      }

      const isIslandTag = (tag: string): boolean => {
        if (islandTags.has(tag))
          return true
        if (tag.includes('.')) {
          const [ns, member] = tag.split('.')
          const nsFile = ns !== undefined ? islandNamespaces.get(ns) : undefined
          if (nsFile !== undefined && member !== undefined) {
            try {
              const target = graph.exportTarget(nsFile, member)
              return analysisOf(target.file, analyses, sources, unparsable)?.isInteractive === true
            }
            catch {}
          }
        }
        return false
      }

      if (islandTags.size > 0 || islandNamespaces.size > 0) {
        walk(analysis.program, (node) => {
          if (node.type !== 'JSXOpeningElement')
            return
          const tag = jsxTagName(node.name)
          if (!isIslandTag(tag))
            return
          for (const attr of node.attributes) {
            if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier')
              continue
            const attrName = attr.name.name
            if (attrName === 'key' || attrName === '$hydrate')
              continue
            if (attr.value?.type !== 'JSXExpressionContainer' || attr.value.expression.type === 'JSXEmptyExpression')
              continue
            const expr = attr.value.expression
            if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') {
              errors.push(formatDiagnostic(
                locOf(root, file, sources, attr.start),
                `kay check: cannot pass function prop "${attrName}" from a server component into island <${tag}>. Define the handler inside the island or pass serializable data.`,
              ))
            }
            else if (expr.type === 'NewExpression' && expr.callee.type === 'Identifier' && !SERIALIZABLE_NEW_CTORS.has(expr.callee.name)) {
              errors.push(formatDiagnostic(
                locOf(root, file, sources, expr.start),
                `kay check: cannot pass non-serializable \`new ${expr.callee.name}()\` prop "${attrName}" into island <${tag}>.`,
              ))
            }
          }
        })
      }
    }

    // Route-specific guardrails (only real route files matching `kay build`)
    if (routeFileSet.has(file) && !basename(file).startsWith('_')) {
      const problem = routeExportProblemLocation(analysis, rel)
      if (problem !== undefined)
        errors.push(formatDiagnostic(locOf(root, file, sources, problem.offset), `kay check: ${problem.message}`))

      if (hasRouteHandlerExport(analysis)) {
        const conflictKey = normalizeRoutePattern(fileToRoutePath(routesDir, file))
        const prev = seenRoutes.get(conflictKey)
        if (prev !== undefined) {
          errors.push(formatDiagnostic(`${rel}:1:1`, `kay check: conflicting routes "${prev}" and "${rel}" both match "${conflictKey}".`))
        }
        else {
          seenRoutes.set(conflictKey, rel)
        }

        // Guardrail 4: dynamic prerender = true route missing paths()
        if (analysis.hasPrerender && (conflictKey.includes(':') || conflictKey.includes('*')) && !analysis.hasPaths) {
          const offset = findExportedConstOffset(analysis, 'prerender')
          errors.push(formatDiagnostic(locOf(root, file, sources, offset), `kay check: dynamic route exports \`prerender = true\` without exporting \`paths()\`.`))
        }
      }
    }
  }

  // 3c. Run plugin check(ctx) hooks inside a real AppRuntimeContext
  if (plugins && plugins.length > 0) {
    const appCtx = createAppContext({
      root,
      outDir,
      publicDir: join(outDir, 'public'),
      assetPrefix,
      dev: false,
    })
    const pluginCtx = {
      root,
      routesDir,
      error(message: string) {
        errors.push(DIAGNOSTIC_PREFIX_RE.test(message) ? message : formatDiagnostic('kay.config.ts:1:1', message))
      },
    }
    for (const plugin of plugins) {
      if (plugin.check !== undefined) {
        try {
          await runWithAppContext(appCtx, () => plugin.check!(pluginCtx))
        }
        catch (err) {
          const msg = `${plugin.name}: ${err instanceof Error ? err.message : String(err)}`
          errors.push(DIAGNOSTIC_PREFIX_RE.test(msg) ? msg : formatDiagnostic('kay.config.ts:1:1', msg))
        }
      }
    }
  }

  // 4. Run TypeScript check (`bun check` preferred, fallback to `tsgo` then `tsc`) when tsconfig.json exists
  const tsconfigPath = join(root, 'tsconfig.json')
  if (!options.skipTypecheck && existsSync(tsconfigPath)) {
    const bunCheck = Bun.spawnSync([process.execPath, 'check', '--no-script', '-p', tsconfigPath], { cwd: root })
    if (bunCheck.exitCode === 0) {
      // Typecheck passed via built-in `bun check`
    }
    else {
      const bunOut = (bunCheck.stdout.toString() + bunCheck.stderr.toString()).trim()
      // Only fall back to tsgo/tsc if this Bun binary does not support `bun check`
      const unsupported = bunOut.includes('Script not found "check"') || bunOut.includes('Unknown command')
      if (!unsupported) {
        errors.push(bunOut || `bun check exited with code ${bunCheck.exitCode}`)
      }
      else {
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
    }
  }

  return { ok: errors.length === 0, checkedFiles: files.length, errors, warnings }
}

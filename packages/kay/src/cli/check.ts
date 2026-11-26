// `kay check [dir]`: validates routes, Kay compiler & island rules (unified with `kay build`), config, and TypeScript types.

import type { IslandIssue } from '../build/islands'
import type { ModuleAnalysis } from '../compiler/analyze'
import type { ComplianceConfig } from '../compiler/compliance'
import type { CheckPluginContext, KayPlugin } from '../plugins/index'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { isTsFile, relPosix, walkFiles, walkRoutes } from '../build/files'
import { ModuleGraph } from '../build/graph'
import { renderProblems } from '../build/render-rules'
import { analyzeIslands } from '../build/islands'
import { fileToRoutePath, hasRouteHandlerExport, missingPathsProblem, normalizeRoutePattern, routeExportProblemLocation, routeFileProblem, SPECIAL_ROUTE_FILES } from '../build/routes'
import { analyzeModule } from '../compiler/analyze'
import { collectProjectComplianceWarnings, shouldEmitWarning } from '../compiler/compliance'
import { collectMistakes, KayMistake, serverOnlyTagError } from '../compiler/mistakes'
import { DIAGNOSTIC_PREFIX_RE, formatDiagnostic, formatLoc } from '../compiler/shared'
import { createAppContext, loadConfig, resolvePlugins, runWithAppContext } from '../plugins/index'

export interface CheckResult {
  ok: boolean
  checkedFiles: number
  errors: string[]
  warnings: string[]
}

/** One diagnostic of `kay check --json`; one without a place (a typecheck dump) has no file, line or col. */
export interface CheckDiagnostic {
  file?: string
  line?: number
  col?: number
  severity: 'error' | 'warning'
  message: string
}

const DIAGNOSTIC_RE = /^(.+?):(\d+):(\d+): (error|warning): ([\s\S]*)$/

export function diagnosticData(text: string, severity: 'error' | 'warning'): CheckDiagnostic {
  const m = DIAGNOSTIC_RE.exec(text)
  if (m === null)
    return { severity, message: text }
  return { file: m[1]!, line: Number(m[2]), col: Number(m[3]), severity: m[4] as 'error' | 'warning', message: m[5]! }
}

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

function locOf(root: string, file: string, sources: Map<string, string>, offset = 0): string {
  const rel = relPosix(root, file)
  const code = sources.get(file)
  return code !== undefined ? formatLoc(rel, code, offset) : `${rel}:1:1`
}

function normalizeDiagnosticPath(root: string, file: string, message: string): string {
  const rel = relPosix(root, file)
  const relMessage = message.replaceAll(file, rel)
  if (DIAGNOSTIC_PREFIX_RE.test(relMessage))
    return relMessage
  return formatDiagnostic(`${rel}:1:1`, relMessage)
}

// Analyzes a file once, reporting every compiler mistake or parse error at its place. A file whose analysis stopped short is remembered in `unparsable` so later graph walks do not re-report it.
function loadCheckedModule(
  file: string,
  root: string,
  analyses: Map<string, ModuleAnalysis>,
  sources: Map<string, string>,
  unparsable: Set<string>,
  errors: string[],
  warnings: string[],
  compliance?: ComplianceConfig | undefined,
  site?: string | undefined,
): ModuleAnalysis | undefined {
  const existing = analyses.get(file)
  if (existing !== undefined)
    return existing
  if (unparsable.has(file) || !isTsFile(file))
    return undefined
  const { value, mistakes, error } = collectMistakes(() => analyzeModule(file, sourceOf(file, sources)))
  const rel = relPosix(root, file)
  for (const m of mistakes)
    errors.push(formatDiagnostic(locOf(root, file, sources, m.start), m.message.replaceAll(file, rel)))
  if (value !== undefined) {
    analyses.set(file, value)
    for (const w of value.warnings) {
      if (shouldEmitWarning(w, compliance, site))
        warnings.push(formatDiagnostic(locOf(root, file, sources, w.start), w.message.replaceAll(file, rel), 'warning'))
    }
    return value
  }
  unparsable.add(file)
  const msg = error instanceof Error ? error.message : String(error)
  errors.push(error instanceof KayMistake && error.start !== undefined
    ? formatDiagnostic(locOf(root, file, sources, error.start), msg.replaceAll(file, rel))
    : normalizeDiagnosticPath(root, file, msg))
  return undefined
}

function formatIslandIssue(issue: IslandIssue, root: string, sources: Map<string, string>): string {
  const rel = relPosix(root, issue.file)
  switch (issue.kind) {
    case 'async-interactive':
      return formatDiagnostic(locOf(root, issue.file, sources, issue.offset), `kay check: async route component cannot use browser interactivity (${issue.reason}). Move interactive state/handlers into a non-async component and render it from the async page.`)
    case 'server-only-tag':
      return formatDiagnostic(locOf(root, issue.file, sources, issue.serverOnly.offset), serverOnlyTagError(rel, issue.serverOnly).message)
    case 'special-interactive':
      return formatDiagnostic(locOf(root, issue.file, sources, issue.offset), `kay check: ${rel} uses browser interactivity (${issue.reason}), but it renders on the server only. Move the interactive part into a component and render that component from ${rel}.`)
    case 'interactive-action':
      return formatDiagnostic(locOf(root, issue.file, sources, issue.offset), `kay check: ${rel} exports server action "${issue.name}" and also uses browser interactivity${issue.reason ? ` (${issue.reason})` : ''}: server action code would leak into the browser bundle. Move "${issue.name}" into a separate non-interactive file (e.g. a .ts actions module).`)
    case 'action-export': {
      const verb = issue.reexport ? 're-exports' : 'imports'
      return formatDiagnostic(locOf(root, issue.file, sources, issue.offset), `kay check: ${verb} non-action "${issue.name}" from server action file ${relPosix(root, issue.target)}. Move ${issue.name} into a module without actions.`)
    }
    case 'server-only-import': {
      const islandRel = relPosix(root, issue.island)
      const message = issue.reexport
        ? `kay check: re-exports from server-only module "${issue.source}" and is reachable from the island in ${islandRel}.`
        : issue.file === issue.island
          ? `kay check: interactive island imports server-only module "${issue.source}". Move server logic to a server action or async server component.`
          : `kay check: imports server-only module "${issue.source}" and is reachable from the island in ${islandRel}. Move server logic to a server action or async server component.`
      return formatDiagnostic(locOf(root, issue.file, sources, issue.offset), message)
    }
    case 'private-env': {
      const envName = issue.envKind === 'bun' ? 'Bun.env' : 'process.env'
      const hint = issue.envKind === 'bun'
        ? 'Bun.env is server-only and is not inlined in browser bundles; use process.env.PUBLIC_* for build-time client values.'
        : 'Only process.env.PUBLIC_* reaches the browser.'
      return formatDiagnostic(locOf(root, issue.file, sources, issue.offset), `kay check: reads ${envName} and is reachable from the island in ${relPosix(root, issue.island)}. ${hint}`)
    }
    case 'compiler-mistake':
      return formatDiagnostic(locOf(root, issue.file, sources, issue.offset), issue.message)
  }
}

// Each plugin's check(ctx) runs inside a real AppRuntimeContext; what it reports without a place lands on kay.config.ts.
async function runPluginChecks(plugins: readonly KayPlugin[], paths: { root: string, routesDir: string, outDir: string, assetPrefix: string }, errors: string[], warnings: string[]): Promise<void> {
  const { root, routesDir, outDir, assetPrefix } = paths
  const appCtx = createAppContext({ root, outDir, publicDir: join(outDir, 'public'), assetPrefix, dev: false })
  const placed = (message: string, severity: 'error' | 'warning'): string =>
    DIAGNOSTIC_PREFIX_RE.test(message) ? message : formatDiagnostic('kay.config.ts:1:1', message, severity)
  const pluginCtx: CheckPluginContext = {
    root,
    routesDir,
    error: message => errors.push(placed(message, 'error')),
    warn: message => warnings.push(placed(message, 'warning')),
  }
  for (const plugin of plugins) {
    if (plugin.check === undefined)
      continue
    try {
      await runWithAppContext(appCtx, () => plugin.check!(pluginCtx))
    }
    catch (err) {
      errors.push(placed(`${plugin.name}: ${err instanceof Error ? err.message : String(err)}`, 'error'))
    }
  }
}


export async function checkProject(rootDir: string, options: { skipTypecheck?: boolean } = {}): Promise<CheckResult> {
  const root = resolve(rootDir)
  const errors: string[] = []

  // 1. Validate kay.config.ts
  let routesDir = resolve(root, 'src/routes')
  let outDir = resolve(root, 'dist')
  let assetPrefix = '/_kay'
  let site: string | undefined
  let compliance: ComplianceConfig | undefined
  let plugins: Awaited<ReturnType<typeof loadConfig>>['plugins'] = []
  try {
    const cfg = await loadConfig(root)
    plugins = resolvePlugins(cfg.plugins)
    site = cfg.site
    compliance = cfg.compliance
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
  const graph = new ModuleGraph(root)
  const { analyses } = graph
  const sources = new Map<string, string>()
  const unparsable = new Set<string>()
  const warnings: string[] = []
  const load = (file: string): ModuleAnalysis | undefined =>
    loadCheckedModule(file, root, analyses, sources, unparsable, errors, warnings, compliance, site)

  for (const file of files)
    load(file)

  // Exact route discovery matching `kay build` (`walkRoutes` skips `_components/` dirs, `.d.ts`, `.test.ts`)
  const routeFiles = existsSync(routesDir) ? walkRoutes(routesDir).sort() : []
  const routeFileSet = new Set(routeFiles)
  const specialFiles = routeFiles.filter(f => SPECIAL_ROUTE_FILES.has(basename(f)))
  const pageFiles = routeFiles.filter(f => !basename(f).startsWith('_') && analyses.has(f) && hasRouteHandlerExport(analyses.get(f)!))

  // 3a. Unified island planning, state-read promotion, special-file checks & reachability checks (shared with `kay build`)
  const islands = analyzeIslands({
    graph,
    root,
    pageFiles,
    specialFiles,
    load,
    includeAllInteractive: true,
    checkLeaks: true,
  })
  for (const issue of islands.issues)
    errors.push(formatIslandIssue(issue, root, sources))

  // 3b. Static guardrails: non-serializable island props, route exports, route conflicts, missing paths()
  const seenRoutes = new Map<string, string>()
  for (const [file, analysis] of [...analyses]) {
    if (NODE_MODULES_RE.test(file))
      continue
    const rel = relPosix(root, file)

    if (file.endsWith('.tsx')) {
      for (const problem of renderProblems(analysis, islands, file, rel, 'kay check'))
        errors.push(formatDiagnostic(locOf(root, file, sources, problem.offset), problem.message))
    }

    // Route-specific guardrails, on the files `kay build` reads as routes
    const isSpecial = SPECIAL_ROUTE_FILES.has(basename(file))
    if (routeFileSet.has(file) && (isSpecial || !basename(file).startsWith('_'))) {
      const fileProblem = routeFileProblem(analysis, rel, relPosix(root, routesDir))
      const problem = fileProblem === undefined ? routeExportProblemLocation(analysis, rel) : { message: fileProblem, offset: 0 }
      if (problem !== undefined)
        errors.push(formatDiagnostic(locOf(root, file, sources, problem.offset), `kay check: ${problem.message}`))
    }
    if (routeFileSet.has(file) && !basename(file).startsWith('_')) {
      if (hasRouteHandlerExport(analysis)) {
        const conflictKey = normalizeRoutePattern(fileToRoutePath(routesDir, file))
        const prev = seenRoutes.get(conflictKey)
        if (prev !== undefined) {
          errors.push(formatDiagnostic(`${rel}:1:1`, `kay check: conflicting routes "${prev}" and "${rel}" both match "${conflictKey}".`))
        }
        else {
          seenRoutes.set(conflictKey, rel)
        }

        const missing = missingPathsProblem(analysis, conflictKey, false)
        if (missing !== undefined)
          errors.push(formatDiagnostic(locOf(root, file, sources, missing.offset), `kay check: ${missing.message}`))
      }
    }
  }

  // 3c. French web law compliance checks (CSS third-party URLs, LCEN legal notice, RGAA accessibility statement)
  warnings.push(...collectProjectComplianceWarnings({ root, srcDir, routesDir, routeFiles, analyses, compliance, site }))

  // 3d. Plugin check(ctx) hooks
  await runPluginChecks(plugins, { root, routesDir, outDir, assetPrefix }, errors, warnings)

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

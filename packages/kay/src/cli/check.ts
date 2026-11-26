// `kay check [dir]`: validates routes, Kay compiler & island rules (unified with `kay build`), config, and TypeScript types.

import type { Program } from 'oxc-parser'
import type { IslandIssue } from '../build/islands'
import type { ModuleAnalysis } from '../compiler/analyze'
import type { CheckPluginContext, KayPlugin } from '../plugins/index'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { isTsFile, relPosix, walkFiles, walkRoutes } from '../build/files'
import { ModuleGraph } from '../build/graph'
import { analyzeIslands } from '../build/islands'
import { fileToRoutePath, hasRouteHandlerExport, normalizeRoutePattern, routeExportProblemLocation, routeFileProblem, SPECIAL_ROUTE_FILES } from '../build/routes'
import { analyzeModule } from '../compiler/analyze'
import { walk } from '../compiler/ast'
import { collectMistakes, KayMistake, serverOnlyTagError } from '../compiler/mistakes'
import { DIAGNOSTIC_PREFIX_RE, formatDiagnostic, formatLoc, isJsxNode, jsxTagName } from '../compiler/shared'
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

const SERIALIZABLE_NEW_CTORS = new Set(['Date', 'Map', 'Set', 'URL', 'RegExp'])
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/

// Names bound once in the file to a function; a name bound twice may be shadowed, so it is left out.
function functionNames(program: Program): Set<string> {
  const bindings = new Map<string, number>()
  const functions = new Set<string>()
  const bind = (name: string): void => {
    bindings.set(name, (bindings.get(name) ?? 0) + 1)
  }
  walk(program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      bind(node.id.name)
      if (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')
        functions.add(node.id.name)
    }
    else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      if (node.type === 'FunctionDeclaration' && node.id !== null) {
        bind(node.id.name)
        functions.add(node.id.name)
      }
      for (const param of node.params)
        walk(param, (p) => { if (p.type === 'Identifier') bind(p.name) })
    }
    else if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') {
      bind(node.local.name)
    }
  })
  for (const name of functions) {
    if (bindings.get(name) !== 1)
      functions.delete(name)
  }
  return functions
}

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
    for (const w of value.warnings)
      warnings.push(formatDiagnostic(locOf(root, file, sources, w.start), w.message.replaceAll(file, rel), 'warning'))
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
      return formatDiagnostic(locOf(root, issue.file, sources, issue.offset), `kay check: async route component cannot use browser interactivity (${issue.reason}).`)
    case 'server-only-tag':
      return formatDiagnostic(locOf(root, issue.file, sources, issue.serverOnly.offset), serverOnlyTagError(rel, issue.serverOnly).message)
    case 'special-interactive':
      return formatDiagnostic(locOf(root, issue.file, sources, issue.offset), `kay check: ${rel} uses browser interactivity (${issue.reason}), but it renders on the server only. Move the interactive part into a component and render that component from ${rel}.`)
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
    case 'private-env':
      return formatDiagnostic(locOf(root, issue.file, sources, issue.offset), `kay check: reads process.env and is reachable from the island in ${relPosix(root, issue.island)}. Only process.env.PUBLIC_* reaches the browser.`)
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

function checkIslandProps(file: string, analysis: ModuleAnalysis, islandTags: ReadonlyMap<string, unknown>, root: string, sources: Map<string, string>, errors: string[]): void {
  // JSX inside the module's own islands runs in the browser, where any prop is fine.
  const inIsland = (offset: number): boolean => analysis.islandSpans.some(([start, end]) => offset >= start && offset < end)
  const localFunctions = functionNames(analysis.program)
  walk(analysis.program, (node) => {
    if (node.type !== 'JSXOpeningElement' || inIsland(node.start))
      return
    const tag = jsxTagName(node.name)
    if (!islandTags.has(tag))
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
      if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression' || (expr.type === 'Identifier' && localFunctions.has(expr.name))) {
        errors.push(formatDiagnostic(
          locOf(root, file, sources, attr.start),
          `kay check: cannot pass function prop "${attrName}" from a server component into island <${tag}>. Define the handler inside the island or pass serializable data.`,
        ))
      }
      else if (attrName !== 'children' && isJsxNode(expr)) {
        errors.push(formatDiagnostic(
          locOf(root, file, sources, attr.start),
          `kay check: cannot pass JSX in prop "${attrName}" from a server component into island <${tag}>; pass it as children, which render on the server, or build it inside the island.`,
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
    plugins = resolvePlugins(cfg.plugins)
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
    loadCheckedModule(file, root, analyses, sources, unparsable, errors, warnings)

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

    const islandTags = islands.pageBindings.get(file)
    if (islandTags !== undefined && file.endsWith('.tsx'))
      checkIslandProps(file, analysis, islandTags, root, sources, errors)

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

        // Dynamic prerender = true route missing paths()
        if (analysis.hasPrerender && (conflictKey.includes(':') || conflictKey.includes('*')) && !analysis.hasPaths) {
          const offset = findExportedConstOffset(analysis, 'prerender')
          errors.push(formatDiagnostic(locOf(root, file, sources, offset), `kay check: dynamic route exports \`prerender = true\` without exporting \`paths()\`.`))
        }
      }
    }
  }

  // 3c. Plugin check(ctx) hooks
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

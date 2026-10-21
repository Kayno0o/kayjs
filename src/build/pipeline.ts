// What `kay build` does, stage by stage, answering what each found and made for the command line to print.
import type { CheckDiagnostic } from '../check'
import type { OtherPage, RenderedPage } from '../check/seo'
import type { KayConfig } from '../config'
import type { Project } from '../project'
import type { ClientBuild } from '../server/client'
import type { KeptStop } from '../server/prerender'
import type { Route } from '../server/routes'
import type { RouteFootprint } from './footprint'
import type { BuildSummary, RouteSize, SizeReport, StageTime, StoredReport } from './report'
import { existsSync, statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { check, configCheckOptions } from '../check'
import { pageSeoLints, unkeptPageLints } from '../check/seo'
import { hasUnseenPages, siteSeoLints } from '../check/site-seo'
import { lintLevel } from '../compiler/lints'
import { CONFIG_FILE, pageHooks } from '../config'
import { setMarkdownDefaults } from '../content/load'
import { writeContentManifests } from '../content/server'
import { cacheDir, clientOptionsOf, resolveProject } from '../project'
import { linkVariantFiles, setImageWidths } from '../runtime/image'
import { setAvifThreads } from '../server/avif'
import { basePath } from '../server/base'
import { writeCards } from '../server/card'
import { ENTRY_RECORD, EXECUTABLE_RECORD, PRERENDERED_DIR } from '../server/client'
import { compressFiles } from '../server/compress'
import { remoteLimits } from '../server/config-limits'
import { writeDictionaryCopies } from '../server/dictionary'
import { FAVICON_DIR, faviconSource } from '../server/favicon'
import { fontFiles } from '../server/fonts'
import { avifQuality, webpQuality, writeImageVariants, writeRemoteVariants } from '../server/image'
import { setImageColors } from '../server/image-color'
import { assetFiles, hookPrerendered } from '../server/page-hook'
import { prerenderPages } from '../server/prerender'
import { remoteImages, remotePatterns } from '../server/remote'
import { slashedPath } from '../server/routes'
import { linkStoredFiles } from '../server/storage'
import { budgetLints, checkBudget, footprintLints } from './budget'
import { cacheCounts, resetCacheCounts } from './cache'
import { buildClient } from './client'
import { compileServer } from './compile'
import { cachedCopies, pruneCopies } from './compressed'
import { writeCachedFavicons } from './favicons'
import { inWalkScope } from './files'
import { routeFootprints } from './footprint'
import { restoreKept, setAsideKept } from './kept'
import { codecWarnings, iconSetPackages, iconSetWarnings, NOTICES_FILE, packagesOf, thirdPartyNotices } from './licenses'
import { readStoredReport, storedReport, writeStoredReport } from './report'
import { routeSizes } from './route-sizes'
import { writeSearchIndex } from './search'
import { inSignalsScope } from './signals'
import { exportStatic, refuseStaticConfig, removeLastExport } from './static'
import { pruneCompileCache } from './transform'
import { loadExecutable, verifyExecutable } from './verify'
import { warnServerClasses } from './warn-classes'

const JSON_EXTENSION = /\.json$/

export type BuildStage = 'check' | 'bundle' | 'output' | 'export' | 'compile'

// What the build is doing now, and how far through it, where the number of things to go through is known.
export interface BuildProgress {
  step: string
  done?: number | undefined
  total?: number | undefined
  unit?: string | undefined
}

type Report = (progress: BuildProgress) => void

export interface BuildOptions {
  // Paths are relative to the root.
  // Checks the project as `kay check` does, with that tsconfig and server entry, before running any of its code; false builds without checking.
  check?: { tsconfig?: string | undefined, entry?: string | undefined } | false
  // Writes the whole site there, for a host with no server.
  exportTo?: string | undefined
  // Bundles the server, `entry` or the project's own, and all of it into one executable.
  // `verify` then starts it as a deploy would and waits for its health route, failing the stage with the server's own output.
  compile?: { outfile: string, entry?: string | undefined, verify?: boolean | 'load' | undefined } | undefined
  // Empties `.kay/cache` first, so nothing an earlier build left there is read; the chunks kept for open tabs and the last build's sizes stay.
  fresh?: boolean | undefined
  // Breaks the size report down by module.
  analyze?: boolean | undefined
  // Fails the build on a warning, the check's or a lint of the output's, as an error does.
  denyWarnings?: boolean | undefined
  // Called with the result so far once each stage that answers something is done, for the command line to print it as it comes rather than after a later stage's own output: the check, the output, the export and the compile.
  onStage?: ((stage: BuildStage, result: BuildResult) => Promise<void> | void) | undefined
  // Called as the build moves on to each step, and through the images it encodes and the routes it prerenders.
  onProgress?: Report | undefined
}

export interface BuildResult {
  // What the check found, then the lints of the prerendered pages' heads.
  checked: CheckDiagnostic[]
  linted: CheckDiagnostic[]
  // The stage that stopped the build, with what it threw unless its problems did. The last build is back in place when the check, the bundle or the output failed.
  failed?: { stage: BuildStage, error?: unknown }
  // `summary` holds what each route loads, the time of each stage and what the caches answered; `previous` the sizes of the last successful build of the same kind, which the sizes are compared to.
  built?: { islands: number, stylesheets: number, prerendered: number, entries: number, report: SizeReport | undefined, summary: BuildSummary, previous: StoredReport | undefined, ms: number }
  exported?: { pages: number, files: number, dir: string, ms: number }
  compiled?: { executable: string, ms: number, verifiedMs?: number | undefined }
}

// Bundles the browser code for production, minified unless kay.config.ts says otherwise, and renders the pages marked `prerender`; the server then boots without bundling.
// It checks the project while it bundles for the browser, runs no page, API module or guard until that passed, and leaves the last build in place when either fails.
export async function buildProject(root: string, config: KayConfig, options: BuildOptions = {}): Promise<BuildResult> {
  return inWalkScope(async () => inSignalsScope(async () => runBuild(root, config, options)))
}

async function runBuild(root: string, config: KayConfig, options: BuildOptions): Promise<BuildResult> {
  checkBudget(config.budget)

  const project = resolveProject(root, config)
  const { output } = project.paths
  const previous = `${output}-previous`
  const checkWith = options.check === false ? undefined : options.check ?? {}
  const checking = checkWith !== undefined
  const exported = options.exportTo !== undefined
  const result: BuildResult = { checked: [], linted: [] }
  // The sizes of the last good build, read before this one can replace them.
  // A server build and a static export each compare to their own last one.
  const reportFile = exported ? project.paths.report.replace(JSON_EXTENSION, '-static.json') : project.paths.report
  const lastReport = await readStoredReport(reportFile, exported)
  let checkMs = 0
  let bundleMs = 0

  resetCacheCounts()

  if (options.fresh)
    await rm(project.paths.cache, { recursive: true, force: true })

  // The last executable and export are no sources: Tailwind scans every file of the project it does not know to skip, the executable and a custom folder among them.
  if (options.compile && statSync(resolve(root, options.compile.outfile), { throwIfNoEntry: false })?.isFile() === true)
    await rm(resolve(root, options.compile.outfile))

  if (options.exportTo !== undefined)
    await removeLastExport(root, resolve(root, options.exportTo))

  // A callback throwing while the last build waits aside puts it back, as a failing stage does.
  const reportAside = async (stage: BuildStage) => {
    try {
      await options.onStage?.(stage, result)
    }
    catch (error) {
      if (checking)
        await putBack(output, previous)

      throw error
    }
  }

  // The chunks of the last build wait beside the output until this one is good, then come back into it.
  await setAsideKept(output, previous)

  // The last build waits aside until this one is known good, which the check decides beside the browser bundle.
  if (checking)
    await setAside(output, previous)
  else
    await rm(previous, { recursive: true, force: true })

  let step: string | undefined
  const report: Report = (progress) => {
    step = progress.step
    options.onProgress?.(progress)
  }
  let checkEnded = !checking
  let bundleEnded = false
  // Whichever of the check and the bundle ends first says what still runs.
  const checkRun = async () => {
    const began = performance.now()

    try {
      return checkWith ? await checkStage(project, checkWith, exported) : []
    }
    finally {
      checkMs = performance.now() - began
      checkEnded = true

      if (!bundleEnded && step === 'checking and bundling')
        report({ step: 'bundling' })
    }
  }
  const bundleRun = async () => {
    const began = performance.now()

    try {
      return await bundleStage(project, exported, options.analyze === true, report)
    }
    finally {
      bundleMs = performance.now() - began
      bundleEnded = true

      if (!checkEnded)
        report({ step: 'checking' })
    }
  }
  const started = performance.now()

  report({ step: checking ? 'checking and bundling' : 'bundling' })

  const [checked, bundled] = await Promise.allSettled([checkRun(), bundleRun()])

  if (checked.status === 'rejected') {
    await putBack(output, previous)

    throw checked.reason
  }

  result.checked = checked.value
  await reportAside('check')

  if (failing(checked.value, options.denyWarnings)) {
    await putBack(output, previous)

    return { ...result, failed: { stage: 'check' } }
  }

  if (bundled.status === 'rejected') {
    if (checking)
      await putBack(output, previous)

    return { ...result, failed: { stage: 'bundle', error: bundled.reason } }
  }

  const client = bundled.value
  let made: Awaited<ReturnType<typeof outputStage>>

  try {
    made = await outputStage(project, exported, client, checking, report)
  }
  catch (error) {
    if (checking)
      await putBack(output, previous)

    return { ...result, failed: { stage: 'output', error } }
  }

  const { prerendered, entries, linted } = made

  result.linted = linted

  if (!failing(linted, options.denyWarnings)) {
    const summary: BuildSummary = { routes: made.routes, footprints: made.footprints, stages: [...checking ? [{ name: 'check', ms: checkMs }] : [], { name: 'bundle', ms: bundleMs }, ...made.stages], caches: cacheCounts() }

    result.built = { islands: Object.keys(client.islands).length, stylesheets: client.styles.size, prerendered, entries, report: options.analyze === true ? client.report : withoutModules(client.report), summary, previous: lastReport, ms: performance.now() - started }
  }

  await reportAside('output')

  if (failing(linted, options.denyWarnings)) {
    await putBack(output, previous)

    return { ...result, failed: { stage: 'output' } }
  }

  await restoreKept(output)
  await rm(previous, { recursive: true, force: true })

  if (options.exportTo !== undefined) {
    const stage = performance.now()

    report({ step: 'exporting' })

    try {
      const dir = resolve(root, options.exportTo)
      const site = await exportStatic(project, client, dir)

      result.exported = { pages: site.pages, files: site.files, dir, ms: performance.now() - stage }
    }
    catch (error) {
      return { ...result, failed: { stage: 'export', error } }
    }

    await options.onStage?.('export', result)
  }

  if (options.compile) {
    const stage = performance.now()

    report({ step: 'compiling' })

    // Gone before the executable is overwritten, so a build stopped half way leaves no record of a binary it replaced.
    await rm(join(output, EXECUTABLE_RECORD), { force: true })

    try {
      const executable = await compileServer(project, { outfile: resolve(root, options.compile.outfile), entry: options.compile.entry === undefined ? undefined : resolve(root, options.compile.entry), packages: shippedPackages(project, client) })

      result.compiled = { executable, ms: performance.now() - stage }

      if (options.compile.verify === 'load')
        result.compiled.verifiedMs = await loadExecutable(executable, root)
      else if (options.compile.verify)
        result.compiled.verifiedMs = await verifyExecutable(executable, root, project.config.health)

      // Written once the executable runs, so `kay start` never runs one that failed its verify.
      await Bun.write(join(output, EXECUTABLE_RECORD), relative(root, executable))
    }
    catch (error) {
      await rm(join(output, EXECUTABLE_RECORD), { force: true })

      return { ...result, failed: { stage: 'compile', error } }
    }

    await options.onStage?.('compile', result)
  }
  else {
    // `kay start` runs the entry of this build, not what an earlier one compiled.
    await rm(join(output, EXECUTABLE_RECORD), { force: true })
  }

  await Bun.write(join(output, ENTRY_RECORD), relative(root, project.paths.entry))

  // Kept only once every stage succeeded, so a failed build leaves the sizes of the last.
  if (result.built)
    await writeStoredReport(reportFile, storedReport(result.built.report, result.built.summary, exported))

  return result
}

// What the browser build bundles, the fonts the pages declare and the icon sets they inline.
function shippedPackages({ root, config }: Project, client: ClientBuild): string[] {
  return [...client.packages ?? [], ...packagesOf(fontFiles(root, config.fonts ?? [])), ...iconSetPackages(root)]
}

// The errors fail a build; warnings are only printed unless `denyWarnings`.
function failing(diagnostics: CheckDiagnostic[], denyWarnings = false): boolean {
  return diagnostics.some(diagnostic => denyWarnings || diagnostic.severity !== 'warning')
}

// The modules a budget made the bundle measure, which only `--analyze` shows.
function withoutModules(report: SizeReport | undefined): SizeReport | undefined {
  return report && { entry: report.entry && { ...report.entry, modules: undefined }, islands: report.islands.map(island => ({ ...island, modules: undefined })) }
}

async function checkStage(project: Project, { tsconfig = 'tsconfig.json', entry }: { tsconfig?: string | undefined, entry?: string | undefined }, exported: boolean): Promise<CheckDiagnostic[]> {
  return check(project.root, { ...configCheckOptions(project.config), tsconfig, entry: entry === undefined ? project.config.entry : relative(project.root, resolve(project.root, entry)), launch: true, exported })
}

// An output set aside earlier is the last good build of a run that was interrupted, and what is in its place now is that run's partial one.
async function setAside(output: string, previous: string) {
  if (existsSync(previous))
    await rm(output, { recursive: true, force: true })
  else if (existsSync(output))
    await rename(output, previous)
}

async function putBack(output: string, previous: string) {
  await rm(output, { recursive: true, force: true })

  if (existsSync(previous))
    await rename(previous, output)
}

// The browser bundles and the variants of the images they import, which run no page, API module or guard, so they build while the check runs.
async function bundleStage(project: Project, exported: boolean, analyze: boolean, report: Report): Promise<ClientBuild> {
  const { root, config } = project

  if (exported)
    refuseStaticConfig(config)

  const client = await buildClient(root, clientOptionsOf(config, project.mode, { exported, report: analyze || (project.config.budget?.js !== undefined && lintLevel('over-budget', project.config.lints) !== 'allow') ? 'modules' : 'sizes' }))

  // A static host cannot pick a format by `Accept`, so an export links WebP alone.
  const avif = exported ? undefined : avifQuality(config.images)

  // Each AVIF holds a thread for up to a second, while WebP encodes on Bun's own.
  setAvifThreads(Math.min(4, availableParallelism()))
  // The ladder is set before the first variant is written, as the server sets it for the pages.
  setImageWidths(config.images?.widths)
  // The prerender may import more images, so the cache is pruned once it has.
  await writeImageVariants(client.dir, webpQuality(config.images), cacheDir(root, 'variants'), { prune: false, avif, onImage: imageProgress(report) })

  return client
}

// The rest of what the server serves from `.kay/client`, which runs the app's content config and pages, so only once the check passed: content manifests, prerendered pages, the variants of images only they import, and favicons, compressed.
async function outputStage(project: Project, exported: boolean, client: ClientBuild, checking: boolean, report: Report): Promise<{ prerendered: number, entries: number, linted: CheckDiagnostic[], routes: RouteSize[], footprints: RouteFootprint[], stages: StageTime[] }> {
  const { root, config, paths } = project
  const stages: StageTime[] = []
  let lapStart = performance.now()
  // Time since the last lap goes to the stage that just ended.
  const lap = (name: string) => {
    const now = performance.now()

    stages.push({ name, ms: now - lapStart })
    lapStart = now
  }

  // The collections are read for the pages, so their time counts with them.
  report({ step: 'prerendering' })

  setMarkdownDefaults(config.markdown)
  setImageColors(config.images?.placeholder !== false)

  // Before prerendering, whose pages read the collections from what it writes.
  const entries = await writeContentManifests(root, paths.output, config.content)

  // A static host has no image route, so pages link the variant files the build writes, and no file route, so stored files where their store serves them.
  if (exported) {
    linkVariantFiles()
    linkStoredFiles(config.storage)
  }

  const rendered: RenderedPage[] = []
  const others: OtherPage[] = []
  const routes: Route[] = []
  const stops = new Map<string, KeptStop>()
  const prerendered = await prerenderPages(project, client, { exportAll: exported, rendered, others, routes, stops, onRoute: (done, total) => report({ step: 'prerendering', done, total, unit: 'routes' }) })

  warnServerClasses(root, client, routes, exported)

  if (config.search === true) {
    report({ step: 'indexing for search' })
    await writeSearchIndex(client.dir, rendered.flatMap(page => page.search === false ? [] : [{ path: slashedPath(page.path, config.trailingSlash), html: page.html, weight: page.search }]))
  }

  lap('prerender')

  const sizes = await routeSizes(root, client, routes, rendered, client.report, others, stops)

  lap('route sizes')

  // Every page ran, so the compiled files of components since deleted can go.
  await pruneCompileCache(cacheDir(root))

  const configFile = join(root, CONFIG_FILE)
  // Read to point a redirect's lint at its line, only when there is one to point at.
  const configSource = checking && config.redirects !== undefined && await Bun.file(configFile).exists() ? await Bun.file(configFile).text() : undefined

  // The heads are the check's to read, so a build without checking skips them with it.
  const linted = [...checking ? [...pageSeoLints(config, rendered, exported), ...siteSeoLints(config, rendered, others, { configFile, configSource, exported, unseen: hasUnseenPages(routes, rendered, others, exported, paths.routes), skipConfigChains: true }), ...unkeptPageLints(config, [...stops.values()])] : [], ...budgetLints(config.budget, config.lints, sizes, routes, client.report)]

  // Remote originals are kept between builds, revalidated as the image route does.
  const remote = remoteImages(cacheDir(root, 'remote'), remotePatterns(config.images?.remote), undefined, undefined, remoteLimits(config.images))

  await writeImageVariants(client.dir, webpQuality(config.images), cacheDir(root, 'variants'), { avif: exported ? undefined : avifQuality(config.images), onImage: imageProgress(report) })
  report({ step: 'writing images, cards and favicons' })
  await writeRemoteVariants(client.dir, remote, webpQuality(config.images))
  await writeCards(client.dir, cacheDir(root, 'cards'), remote)
  lap('images and cards')

  const favicon = faviconSource(root, config.favicon, config.manifest)

  // The check warned of what an SVG draws poorly already.
  if (favicon !== undefined)
    await writeCachedFavicons(favicon, join(client.dir, '..', FAVICON_DIR), cacheDir(root, 'favicons'), checking ? () => undefined : undefined)

  lap('favicons')

  for (const warning of [...iconSetWarnings(root), ...codecWarnings(root)])
    console.warn(warning)

  await Bun.write(join(client.dir, NOTICES_FILE), thirdPartyNotices(shippedPackages(project, client)))

  const hooks = pageHooks(config.extensions)

  if (hooks.length > 0)
    report({ step: 'running page hooks' })

  await hookPrerendered(root, hooks, { clientDir: client.dir, publicDir: paths.public, base: basePath(config.base), aspects: config.images?.aspects }, paths.output)
  lap('page hooks')
  report({ step: 'compressing' })
  const copies = cachedCopies(cacheDir(root, 'compressed'))

  await Promise.all([compressFiles(client.dir, copies), compressFiles(join(paths.output, PRERENDERED_DIR), copies)])
  await writeDictionaryCopies(join(paths.output, PRERENDERED_DIR), client)

  // A static export compresses its own pages next, which can share content with these, so it prunes once it has.
  if (!exported)
    await pruneCopies(cacheDir(root, 'compressed'))

  lap('compress')

  // Read from the files the build wrote, hooks included, with the image variants they link and the gzip copies a host serves.
  const footprints = await routeFootprints(join(paths.output, PRERENDERED_DIR), client.pages, routes, assetFiles({ clientDir: client.dir, publicDir: paths.public, base: basePath(config.base), aspects: config.images?.aspects }), !exported && avifQuality(config.images) !== undefined)

  linted.push(...footprintLints(config.budget, config.lints, footprints, routes))
  lap('page footprints')

  return { prerendered, entries, linted, routes: sizes, footprints, stages }
}

function imageProgress(report: Report): (done: number, total: number) => void {
  return (done, total) => report({ step: 'encoding images', done, total, unit: 'images' })
}

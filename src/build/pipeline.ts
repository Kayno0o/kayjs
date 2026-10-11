// What `kay build` does, stage by stage, answering what each found and made for the command line to print.
import type { CheckDiagnostic } from '../check'
import type { RenderedPage } from '../check/seo'
import type { KayConfig } from '../config'
import type { Project } from '../project'
import type { ClientBuild } from '../server/client'
import type { SizeReport } from './report'
import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { check, configCheckOptions } from '../check'
import { pageSeoLints } from '../check/seo'
import { pageHooks } from '../config'
import { writeContentManifests } from '../content/server'
import { cacheDir, clientOptionsOf, resolveProject } from '../project'
import { linkVariantFiles } from '../runtime/image'
import { setAvifThreads } from '../server/avif'
import { basePath } from '../server/base'
import { writeCards } from '../server/card'
import { EXECUTABLE_RECORD, PRERENDERED_DIR } from '../server/client'
import { compressFiles } from '../server/compress'
import { FAVICON_DIR, faviconSource, writeFavicons } from '../server/favicon'
import { avifQuality, writeImageVariants, writeRemoteVariants } from '../server/image'
import { hookPrerendered } from '../server/page-hook'
import { prerenderPages } from '../server/prerender'
import { remoteImages, remotePatterns } from '../server/remote'
import { slashedPath } from '../server/routes'
import { linkStoredFiles } from '../server/storage'
import { buildClient } from './client'
import { compileServer } from './compile'
import { writeSearchIndex } from './search'
import { exportStatic, refuseStaticConfig } from './static'

export type BuildStage = 'check' | 'bundle' | 'output' | 'export' | 'compile'

export interface BuildOptions {
  // Paths are relative to the root.
  // Checks the project as `kay check` does, with that tsconfig and server entry, before running any of its code; false builds without checking.
  check?: { tsconfig?: string | undefined, entry?: string | undefined } | false
  // Writes the whole site there, for a host with no server.
  exportTo?: string | undefined
  // Bundles the server, `entry` or the project's own, and all of it into one executable.
  compile?: { outfile: string, entry?: string | undefined } | undefined
  // Breaks the size report down by module.
  analyze?: boolean | undefined
  // Called with the result so far once each stage that answers something is done, for the command line to print it as it comes rather than after a later stage's own output: the check, the output, the export and the compile.
  onStage?: ((stage: BuildStage, result: BuildResult) => Promise<void> | void) | undefined
}

export interface BuildResult {
  // What the check found, then the lints of the prerendered pages' heads.
  checked: CheckDiagnostic[]
  linted: CheckDiagnostic[]
  // The stage that stopped the build, with what it threw unless its problems did. The last build is back in place when the check, the bundle or the output failed.
  failed?: { stage: BuildStage, error?: unknown }
  built?: { islands: number, stylesheets: number, prerendered: number, entries: number, report: SizeReport | undefined, ms: number }
  exported?: { pages: number, files: number, dir: string, ms: number }
  compiled?: { executable: string, ms: number }
}

// Bundles the browser code for production, minified unless kay.config.ts says otherwise, and renders the pages marked `prerender`; the server then boots without bundling.
// It checks the project while it bundles for the browser, runs no page, API module or guard until that passed, and leaves the last build in place when either fails.
export async function buildProject(root: string, config: KayConfig, options: BuildOptions = {}): Promise<BuildResult> {
  const project = resolveProject(root, config)
  const { output } = project.paths
  const previous = `${output}-previous`
  const checkWith = options.check === false ? undefined : options.check ?? {}
  const checking = checkWith !== undefined
  const exported = options.exportTo !== undefined
  const result: BuildResult = { checked: [], linted: [] }
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

  // The last build waits aside until this one is known good, which the check decides beside the browser bundle.
  if (checking)
    await setAside(output, previous)
  else
    await rm(previous, { recursive: true, force: true })

  const started = performance.now()
  const [checked, bundled] = await Promise.allSettled([checkWith ? checkStage(project, checkWith, exported) : [], bundleStage(project, exported, options.analyze === true)])

  if (checked.status === 'rejected') {
    await putBack(output, previous)

    throw checked.reason
  }

  result.checked = checked.value
  await reportAside('check')

  if (failing(checked.value)) {
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
    made = await outputStage(project, exported, client, checking)
  }
  catch (error) {
    if (checking)
      await putBack(output, previous)

    return { ...result, failed: { stage: 'output', error } }
  }

  const { prerendered, entries, linted } = made

  result.linted = linted

  if (!failing(linted))
    result.built = { islands: Object.keys(client.islands).length, stylesheets: client.styles.size, prerendered, entries, report: client.report, ms: performance.now() - started }

  await reportAside('output')

  if (failing(linted)) {
    await putBack(output, previous)

    return { ...result, failed: { stage: 'output' } }
  }

  await rm(previous, { recursive: true, force: true })

  if (options.exportTo !== undefined) {
    const stage = performance.now()

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

    try {
      const executable = await compileServer(project, { outfile: resolve(root, options.compile.outfile), entry: options.compile.entry === undefined ? undefined : resolve(root, options.compile.entry) })

      await Bun.write(join(output, EXECUTABLE_RECORD), relative(root, executable))

      result.compiled = { executable, ms: performance.now() - stage }
    }
    catch (error) {
      return { ...result, failed: { stage: 'compile', error } }
    }

    await options.onStage?.('compile', result)
  }
  else {
    // `kay start` runs the entry of this build, not what an earlier one compiled.
    await rm(join(output, EXECUTABLE_RECORD), { force: true })
  }

  return result
}

// The errors fail a build; warnings are only printed.
function failing(diagnostics: CheckDiagnostic[]): boolean {
  return diagnostics.some(diagnostic => diagnostic.severity !== 'warning')
}

async function checkStage(project: Project, { tsconfig = 'tsconfig.json', entry }: { tsconfig?: string | undefined, entry?: string | undefined }, exported: boolean): Promise<CheckDiagnostic[]> {
  return check(project.root, { ...configCheckOptions(project.config), tsconfig, entry: entry === undefined ? undefined : relative(project.root, resolve(project.root, entry)), launch: true, exported })
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
async function bundleStage(project: Project, exported: boolean, analyze: boolean): Promise<ClientBuild> {
  const { root, config } = project

  if (exported)
    refuseStaticConfig(config)

  const client = await buildClient(root, clientOptionsOf(config, project.mode, { exported, report: analyze ? 'modules' : 'sizes' }))

  // A static host cannot pick a format by `Accept`, so an export links WebP alone.
  const avif = exported ? undefined : avifQuality(config.images)

  // Each AVIF holds a thread for up to a second, while WebP encodes on Bun's own.
  setAvifThreads(Math.min(4, availableParallelism()))
  // The prerender may import more images, so the cache is pruned once it has.
  await writeImageVariants(client.dir, config.images?.quality, cacheDir(root, 'variants'), { prune: false, avif })

  return client
}

// The rest of what the server serves from `.kay/client`, which runs the app's content config and pages, so only once the check passed: content manifests, prerendered pages, the variants of images only they import, and favicons, compressed.
async function outputStage(project: Project, exported: boolean, client: ClientBuild, checking: boolean): Promise<{ prerendered: number, entries: number, linted: CheckDiagnostic[] }> {
  const { root, config, paths } = project
  // Before prerendering, whose pages read the collections from what it writes.
  const entries = await writeContentManifests(root, paths.output, config.content)

  // A static host has no image route, so pages link the variant files the build writes, and no file route, so stored files where their store serves them.
  if (exported) {
    linkVariantFiles()
    linkStoredFiles(config.storage)
  }

  const rendered: RenderedPage[] = []
  const prerendered = await prerenderPages(project, client, { exportAll: exported, rendered })

  if (config.search === true)
    await writeSearchIndex(client.dir, rendered.flatMap(page => page.search === false ? [] : [{ path: slashedPath(page.path, config.trailingSlash), html: page.html, weight: page.search }]))

  // The heads are the check's to read, so a build without checking skips them with it.
  const linted = checking ? pageSeoLints(config, rendered, exported) : []

  // Remote originals are kept between builds, revalidated as the image route does.
  const remote = remoteImages(cacheDir(root, 'remote'), remotePatterns(config.images?.remote))

  await writeImageVariants(client.dir, config.images?.quality, cacheDir(root, 'variants'), { avif: exported ? undefined : avifQuality(config.images) })
  await writeRemoteVariants(client.dir, remote, config.images?.quality)
  await writeCards(client.dir, cacheDir(root, 'cards'), remote)

  const favicon = faviconSource(root, config.favicon, config.manifest)

  // The check warned of what an SVG draws poorly already.
  if (favicon !== undefined)
    await writeFavicons(favicon, join(client.dir, '..', FAVICON_DIR), checking ? () => undefined : undefined)

  await hookPrerendered(root, pageHooks(config.extensions), { clientDir: client.dir, publicDir: paths.public, base: basePath(config.base), aspects: config.images?.aspects })
  await Promise.all([compressFiles(client.dir), compressFiles(join(paths.output, PRERENDERED_DIR))])

  return { prerendered, entries, linted }
}

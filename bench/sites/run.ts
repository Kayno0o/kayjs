import type { Browser } from 'playwright-core'
import type { Vitals } from './browser'
import type { BuildTime, Footprint } from './build'
import type { DevResult } from './dev'
import type { ColdStart, Load } from './load'
import type { Variant } from './sites'
import type { Weight } from './weigh'
import { constants, cpus } from 'node:os'
import { join } from 'node:path'
import { launch } from '../browser'
import { kilobytes, milliseconds, table } from '../format'
import { PROFILES, vitals } from './browser'
import { buildCommands, footprint, timeBuild } from './build'
import { development, devSection } from './dev'
import { coldStart, load } from './load'
import { serverMemory, startAll, stopEverything } from './serve'
import { commitOf, KIND, label, NO_SITES, PHASE, prepare, SITES, staleInstalls, startServices, stopServices, VARIANTS, versionIn } from './sites'
import { VIEWPORTS, weigh } from './weigh'

interface Result {
  builds: BuildTime[]
  footprint: Footprint
  weights: Weight[]
  cold: ColdStart
  loads: Load[]
  memory: { pss: number, peak: number }
  vitals: Record<string, Vitals[]>
}

const STYLESHEET = /<link rel="stylesheet" href="([^"]+)"/g
const MB = 1024 * 1024
const STOP_MS = 10_000

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const megabytes = (bytes: number) => `${(bytes / MB).toFixed(0)} MB`

// The site's own stylesheet, the largest a page links, none when its pages carry theirs.
async function stylesheet(variant: Variant): Promise<string[]> {
  const html = await (await fetch(`http://127.0.0.1:${variant.ports.backend}/`)).text()
  const sizes = await Promise.all([...html.matchAll(STYLESHEET)].map(async ([, href]) => ({ href: href!, size: (await (await fetch(`http://127.0.0.1:${variant.ports.backend}${href}`)).arrayBuffer()).byteLength })))

  return sizes.toSorted((a, b) => b.size - a.size).slice(0, 1).map(({ href }) => href)
}

if (VARIANTS.length === 0)
  throw new Error(SITES.length === 0 ? NO_SITES : 'PHASE=dev: no site in the config names what its dev phase edits, `dev`')

let browser: Browser | undefined
let stopping = false

// An interrupted run stops what it started, so no server it leaves holds a port the next run would be timed against; what is slow to stop or fails to is left behind, and a second signal exits at once.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (stopping)
      process.exit(128 + constants.signals[signal])

    stopping = true
    void (async () => {
      try {
        // Each step runs, one failing or not: a sidecar runs in its variant's directory, which a server that exited first no longer holds in its tree.
        for (const step of [async () => stopEverything(VARIANTS.flatMap(variant => [variant.dir, variant.devDir])), stopServices, async () => browser?.close()]) {
          try {
            await Promise.race([step(), Bun.sleep(STOP_MS)])
          }
          catch (error) {
            console.error(error)
          }
        }
      }
      finally {
        process.exit(128 + constants.signals[signal])
      }
    })()
  })
}

if ((process.env.SKIP_PREPARE ?? '') === '') {
  console.error('exporting, installing and building the sites')
  await prepare()
}
else {
  for (const warning of await staleInstalls())
    console.error(warning)
}

// eslint-disable-next-line unused-imports/no-unused-vars -- held for its disposal, which stops the services as the run ends, failed or not
await using _services = await startServices()
const results = new Map<Variant, Result>()
const producing = PHASE !== 'dev'

for (const variant of producing ? VARIANTS : []) {
  console.error(`builds: ${label(variant)}`)

  const builds: BuildTime[] = []

  for (const command of buildCommands(variant))
    builds.push(await timeBuild(variant, command))
  results.set(variant, { builds, footprint: footprint(variant), weights: [], cold: { ms: 0, pss: 0 }, loads: [], memory: { pss: 0, peak: 0 }, vitals: {} })
}

for (const variant of producing ? VARIANTS : []) {
  console.error(`cold start: ${label(variant)}`)
  results.get(variant)!.cold = await coldStart(variant)
}

const lab = producing ? await startAll() : undefined

try {
  browser = await launch()
}
catch (error) {
  await lab?.stop()

  throw error
}

try {
  for (const variant of producing ? VARIANTS : []) {
    const result = results.get(variant)!
    const server = lab!.servers.get(variant)!

    console.error(`weight and load: ${label(variant)}`)
    for (const path of variant.site.pages)
      result.weights.push(await weigh(variant, path))
    for (const path of [...variant.site.loaded ?? variant.site.pages.slice(0, 2), ...await stylesheet(variant)])
      result.loads.push(await load(variant, path, server, lab!.nginx))
    result.memory = serverMemory(server.pid)
  }

  for (const profile of producing ? PROFILES : []) {
    for (const variant of VARIANTS) {
      console.error(`browser ${profile.name}: ${label(variant)}`)
      results.get(variant)!.vitals[profile.name] = []
      for (const path of variant.site.pages)
        results.get(variant)!.vitals[profile.name]!.push(await vitals(browser, variant, path, profile))
    }
  }

  // The dev servers run on a machine the production servers left.
  await lab?.stop()

  const dev = PHASE === 'prod' ? new Map<Variant, DevResult>() : await development(browser)
  const header = ['', ...VARIANTS.map(label)]
  const row = (name: string, value: (result: Result, variant: Variant) => string) => [name, ...VARIANTS.map(variant => value(results.get(variant)!, variant))]
  const averageOf = (pick: (weight: Weight) => number) => (result: Result) => kilobytes(average(result.weights.map(pick)))
  const vitalsOf = (profile: string, pick: (page: Vitals) => number, format: (value: number) => string) => (result: Result) => format(average(result.vitals[profile]!.map(pick)))
  const environment = [
    `${cpus()[0]?.model ?? 'unknown CPU'}, ${cpus().length} threads`,
    `Bun ${Bun.version}, Chromium ${browser.version()} headless, ${nginxVersion()}`,
    ...await Promise.all(SITES.filter(site => VARIANTS.some(variant => variant.site === site)).map(async (site) => {
      const sides = await Promise.all(VARIANTS.filter(variant => variant.site === site).map(async variant => variant.kind === 'astro' ? `Astro at ${commitOf(variant)}` : `kay ${await versionIn(producing ? variant.dir : variant.devDir, 'kay')} at ${commitOf(variant)}`))

      return `${site.name}: ${sides.join(', ')}`
    })),
    `run on ${new Date().toISOString().slice(0, 10)}`,
  ]
  const production = !producing
    ? []
    : [
      'Each site as it last ran on Astro, then on kay, built and served as it deploys: Astro\'s standalone server under Bun, kay\'s one executable, both behind an nginx set up for production (HTTP/2 over TLS, brotli and gzip at level 6). kay is the version each site pins, not this checkout. Reproduce with `bun run bench:sites`, the sites listed in a config as `bench/sites/sites.config.example.ts` shows, given nginx with the brotli module (`NGINX_MODULES` if not under /usr/lib/nginx/modules), openssl, playwright-core\'s Chromium, and cloc for the line counts.',
      '',
      '## What a page downloads',
      '',
      `Average over every page: text as brotli at quality 11 sends it, images as served at each viewport (${VIEWPORTS.map(viewport => `${viewport.name} ${viewport.width} px at ${viewport.dpr}x`).join(', ')}), and the fonts the stylesheets can load for Latin text.`,
      '',
      table(header, [
        row('HTML', averageOf(weight => weight.html)),
        row('CSS', averageOf(weight => weight.css)),
        row('JS', averageOf(weight => weight.js)),
        row('JS files', result => average(result.weights.map(weight => weight.jsFiles)).toFixed(1)),
        ...VIEWPORTS.map(viewport => row(`images, ${viewport.name}`, averageOf(weight => weight.images[viewport.name]!))),
        row('fonts', averageOf(weight => weight.fonts)),
      ]),
      '',
      '## In a browser',
      '',
      `Every page loaded cold, ${process.env.RUNS ?? 5} times in a fresh context, medians averaged over the pages, with Lighthouse's throttling: a phone on slow 4G with a 4x slower CPU, and a desktop on cable. Total blocking time counts long tasks from the first paint on.`,
      '',
      table(header, PROFILES.flatMap(profile => [
        row(`${profile.name} first paint (ms)`, vitalsOf(profile.name, page => page.fcp, milliseconds)),
        row(`${profile.name} largest paint (ms)`, vitalsOf(profile.name, page => page.lcp, milliseconds)),
        row(`${profile.name} blocking time (ms)`, vitalsOf(profile.name, page => page.tbt, milliseconds)),
        row(`${profile.name} layout shift`, vitalsOf(profile.name, page => page.cls, value => value.toFixed(3))),
        row(`${profile.name} load (ms)`, vitalsOf(profile.name, page => page.load, milliseconds)),
        row(`${profile.name} transferred`, vitalsOf(profile.name, page => page.bytes, kilobytes)),
        row(`${profile.name} requests`, vitalsOf(profile.name, page => page.requests, value => value.toFixed(1))),
      ])),
      '',
      '## Server',
      '',
      `Cold start is from spawning the server to its first 200 on the home page, median of 7. Under load, 32 clients request one URL through nginx for 5 s over keepalive HTTP/1.1, accepting brotli; CPU is per request, of the site's server and of nginx, which compresses what the server sent uncompressed. The client is Bun's fetch, which tops out near 40,000 requests a second. Memory is proportional (PSS), counting once the pages processes share; its peak is resident (RSS).${VARIANTS.some(variant => variant.site.sidecar?.[variant.kind] !== undefined) ? ' A server with a sidecar, as an API its pages fetch from, counts with it: cold start waits for both to answer, memory and CPU are their sums.' : ''}`,
      '',
      table(header, [
        row('cold start', result => `${milliseconds(result.cold.ms)} ms`),
        row('memory once started', result => megabytes(result.cold.pss)),
        row('memory after load (peak)', result => `${megabytes(result.memory.pss)} (${megabytes(result.memory.peak)})`),
      ]),
      '',
      table(['', 'URL', 'req/s', 'p50 (ms)', 'p99 (ms)', 'server CPU (µs/req)', 'nginx CPU (µs/req)'], VARIANTS.flatMap(variant => results.get(variant)!.loads.map(entry => [label(variant), `\`${entry.url}\``, entry.rps.toFixed(0), milliseconds(entry.p50), milliseconds(entry.p99), entry.serverCpu.toFixed(0), entry.nginxCpu.toFixed(0)]))),
      '',
      '## Build and code',
      '',
      'Clean builds, median of 3. `kay build` runs `kay check` first, which `astro build` has no equivalent of. Lines are cloc\'s code lines of `src` and the config files.',
      '',
      table(['', 'command', 'wall (s)', 'CPU (s)', 'peak memory'], VARIANTS.flatMap(variant => results.get(variant)!.builds.map(build => [label(variant), `\`${build.command}\``, build.wall.toFixed(2), build.cpu.toFixed(1), megabytes(build.rss)]))),
      '',
      table(header, [
        row('lines of code', result => String(result.footprint.lines ?? '-')),
        row('lines of tests', result => String(result.footprint.testLines ?? '-')),
        row('deployed', (result, variant) => `${megabytes(result.footprint.deploy)} ${variant.kind === 'astro' ? '(dist and production node_modules)' : '(one executable)'}`),
      ]),
      '',
    ]
  const markdown = [
    '# Benchmark: the sites before and after kay',
    '',
    ...environment.map(line => `- ${line}`),
    '',
    ...production,
    ...devSection(dev),
  ].join('\n')

  await Bun.write(join(import.meta.dir, `${['results', KIND, PHASE].filter(part => part !== undefined).join('.')}.md`), markdown)
  console.log(markdown)
}
finally {
  await browser.close()
  await lab?.stop()
}

// nginx prints its version on stderr.
function nginxVersion(): string {
  return Bun.spawnSync(['nginx', '-v'], { stderr: 'pipe' }).stderr.toString().trim().replace('nginx version: ', '')
}

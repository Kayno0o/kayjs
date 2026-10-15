import type { ScriptAnalysis } from '../compiler/script'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import process from 'node:process'
import { browserGlobalMissing } from '../compiler/globals'
import { countCache, readCacheEntry, writeCacheEntry } from './cache'

// What a specifier starts with when it names no package: a relative path, a URL scheme such as `node:`, kay itself or an icon.
const NOT_A_PACKAGE = String.raw`[./]|[a-z]+:|kay(?![^/'"])|~icons/`
// A package import, its package name in the first group.
const PACKAGE_IMPORT = new RegExp(`^(?!${NOT_A_PACKAGE})(@[^/]+/[^/]+|[^/]+)`)
// A quoted package specifier, read off a component's source before parsing it.
const QUOTED_PACKAGE = new RegExp(String.raw`\b(?:from|import)\s*['"](?!${NOT_A_PACKAGE})`)
// Imports the module the environment names, prints what it threw as `[name, message]` after a marker the package's own output cannot be taken for, and exits whatever the package left running.
const PROBE_MARKER = '\0kay-probe '
const PROBE = `let thrown = []; try { await import(process.env.KAY_PROBE) } catch (error) { thrown = error instanceof Error ? [error.name, error.message] : [] } console.log(${JSON.stringify(PROBE_MARKER)} + JSON.stringify(thrown)); process.exit(0)`
const PROBE_TIMEOUT_MS = 10_000
const probed = new Map<string, Promise<boolean>>()

// Whether the source may import a package at all, which most components do not.
export function mayImportPackage(source: string): boolean {
  return QUOTED_PACKAGE.test(source)
}

// The packages a script fence imports, type-only imports aside, which are the ones that may throw as they load.
export function packagesToProbe(source: string, script: ScriptAnalysis): string[] {
  const { imports, specifiers: quoted } = script
  const specifiers = new Set(imports.filter(binding => !binding.typeOnly).map(binding => binding.source))

  // A side-effect import binds no name.
  for (const span of quoted) {
    const specifier = source.slice(span.start + 1, span.end - 1)

    if (!imports.some(binding => binding.source === specifier))
      specifiers.add(specifier)
  }

  return [...specifiers].filter(specifier => PACKAGE_IMPORT.test(specifier))
}

// Whether any of the packages throws as it loads without a DOM.
export async function anyBrowserOnly(specifiers: string[], importer: string, cacheDir?: string): Promise<boolean> {
  const results = await Promise.all(specifiers.map(async specifier => browserOnly(specifier, dirname(importer), cacheDir)))

  return results.includes(true)
}

// Whether a package the script fence imports, type-only imports aside, throws as it loads without a DOM: such a component cannot render on the server.
export async function importsBrowserOnly(source: string, script: ScriptAnalysis, importer: string, cacheDir?: string): Promise<boolean> {
  return anyBrowserOnly(packagesToProbe(source, script), importer, cacheDir)
}

// Imported once per package version in a process of its own; the answer is kept in `.kay/cache` when there is one.
async function browserOnly(specifier: string, from: string, cacheDir: string | undefined): Promise<boolean> {
  let file: string

  try {
    file = Bun.resolveSync(specifier, from)
  }
  catch {
    // The import itself reports a package that is not installed.
    return false
  }

  // An installed package changes with its version; a linked one or the app's own file with its contents. Bun decides the globals and the error's wording.
  const installed = file.includes(`${sep}node_modules${sep}`)
  const stamp = installed ? packageVersion(file, PACKAGE_IMPORT.exec(specifier)![1]!) : fileStamp(file)
  const key = `${specifier}@${stamp}\0${file}\0${Bun.version}`
  // Kept per cache too, so a build with a cache writes the answer a run without one found.
  const remembered = `${cacheDir ?? ''}\0${key}`
  let answer = probed.get(remembered)

  if (!answer) {
    answer = cachedProbe(key, file, from, cacheDir)
    probed.set(remembered, answer)
  }

  return answer
}

async function cachedProbe(key: string, file: string, from: string, cacheDir: string | undefined): Promise<boolean> {
  const slot = cacheDir === undefined ? undefined : { file: join(cacheDir, `${Bun.hash(key).toString(36)}-browser-only.json`), key }
  const cached = slot && await readCacheEntry<boolean>(slot)

  if (slot)
    countCache('package probes', cached !== undefined)

  if (cached !== undefined)
    return cached

  const answer = await probe(file, from)

  if (slot && answer !== undefined)
    await writeCacheEntry(slot, answer)

  return answer ?? false
}

// True when loading the module throws on a global only the browser has; undefined when it did not finish in time, which is not kept.
async function probe(file: string, from: string): Promise<boolean | undefined> {
  const child = Bun.spawn([process.execPath, '-e', PROBE], { cwd: from, env: { ...process.env, KAY_PROBE: file }, stdout: 'pipe', stderr: 'ignore' })
  const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS)
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  clearTimeout(timer)

  if (child.signalCode !== null && code !== 0)
    return undefined

  const [name, message] = probeResult(output)

  return browserGlobalMissing({ name, message }) !== undefined
}

function probeResult(output: string): unknown[] {
  const at = output.lastIndexOf(PROBE_MARKER)

  if (at === -1)
    return []

  const line = output.slice(at + PROBE_MARKER.length)
  const end = line.indexOf('\n')

  try {
    const parsed = JSON.parse(end === -1 ? line : line.slice(0, end)) as unknown

    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

function fileStamp(file: string): string {
  const { mtimeMs, size } = statSync(file)

  return `${mtimeMs}-${size}`
}

// The version of the installed package `name`, read off the nearest package.json naming it above the file it resolved to.
function packageVersion(file: string, name: string): string {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')

    if (!existsSync(manifest))
      continue

    try {
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string, version?: string }

      if (json.name === name)
        return json.version ?? ''
    }
    catch {}
  }

  return ''
}

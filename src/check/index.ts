import type { Diagnostic, SourceMap } from '../compiler'
import { readdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ASSET_EXTENSIONS } from '../build/assets'
import { findKayFiles, writeIfChanged } from '../build/files'
import { compileKay } from '../compiler'
import { codeFrame } from '../compiler/frame'
import { offsetAt, positionAt } from '../compiler/mapping'
import { publicFiles } from '../server/public'
import { routeOf, scanRoutes } from '../server/routes'

export const SHADOW_DIR = join('.kay', 'types')

export interface CheckOptions {
  tsconfig?: string
  // Page directory relative to the root, so `ctx.params` is typed per route.
  routes?: string
  // Public file directory relative to the root, whose files links may point at.
  publicDir?: string
}

export interface CheckDiagnostic {
  file: string
  line: number
  column: number
  message: string
  code?: string
}

export interface ShadowFile {
  source: string
  file: string
  tsx: string
  map: SourceMap
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+): (.*)$/
// An error about the whole run, such as a tsconfig that does not exist.
const TSC_GLOBAL_LINE = /^error (TS\d+): (.*)$/
// Stylesheets import for their effect, other assets for their URL. TypeScript matches a wildcard module case-sensitively, so both `.png` and `.PNG` are declared; a mixed case such as `.Png` is not.
const ASSET_TYPES = ['declare module \'*.css\' {}\n', ...ASSET_EXTENSIONS.flatMap(extension => [extension, extension.toUpperCase()]).map(extension => `declare module '*.${extension}' {\n  const url: string\n  export default url\n}\n`)].join('\n')

export const TSGO = join(dirname(fileURLToPath(import.meta.resolve('@typescript/native-preview/package.json'))), 'bin', 'tsgo')

// Compiles every .kay file under `root` to `.kay/types/<path>.kay.tsx`, the tree tsconfig `rootDirs` merges with the sources.
export async function writeShadowTypes(projectRoot: string, options: CheckOptions = {}): Promise<{ files: Map<string, ShadowFile>, diagnostics: CheckDiagnostic[] }> {
  const root = resolve(projectRoot)
  const files = new Map<string, ShadowFile>()
  const diagnostics: CheckDiagnostic[] = []
  const routesDir = resolve(root, options.routes ?? 'src/routes')

  const environmentPath = join(root, SHADOW_DIR, 'kay-env.d.ts')
  const assetsPath = join(root, SHADOW_DIR, 'kay-assets.d.ts')

  for (const file of await findKayFiles(root, { project: true })) {
    const source = await Bun.file(file).text()
    const { shadow, diagnostics: compileDiagnostics } = compileShadow(root, routesDir, file, source)
    const path = shadowPath(root, file)

    await writeIfChanged(path, shadow.tsx)
    files.set(path, shadow)
    for (const diagnostic of compileDiagnostics)
      diagnostics.push({ file, ...positionAt(source, diagnostic.start), message: diagnostic.message })
  }

  const [routes, publicPaths] = await Promise.all([scanRoutes(routesDir), publicFiles(resolve(root, options.publicDir ?? 'public'))])

  await writeIfChanged(environmentPath, environment(routes.map(route => route.pattern), publicPaths.map(file => file.url)))
  // A script rather than a module, which is what lets it declare a wildcard module.
  await writeIfChanged(assetsPath, ASSET_TYPES)

  // Rewriting in place keeps every shadow file present for editors reading the tree meanwhile; only stale ones go.
  const stale = (await readdir(join(root, SHADOW_DIR), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .filter(path => path !== environmentPath && path !== assetsPath && !files.has(path))

  await Promise.all(stale.map(async path => rm(path)))

  return { files, diagnostics }
}

export function shadowPath(root: string, file: string): string {
  return join(root, SHADOW_DIR, `${relative(root, file)}.tsx`)
}

// Compiles one .kay file for type checking, its route params typed when it is a page under `routesDir`.
export function compileShadow(root: string, routesDir: string, file: string, source: string): { shadow: ShadowFile, diagnostics: Diagnostic[] } {
  const params = file.startsWith(routesDir + sep) ? routeOf(routesDir, file)?.params : undefined
  const shadowDir = dirname(shadowPath(root, file))
  // rootDirs only merges paths inside the project, so an import reaching outside it is pointed there from the shadow file.
  const relocateImport = (specifier: string) => {
    if (!specifier.startsWith('.'))
      return undefined

    const target = resolve(dirname(file), specifier)

    return target.startsWith(root + sep) ? undefined : relative(shadowDir, target)
  }
  const { tsx, map, diagnostics } = compileKay(source, file, { root, params, check: true, relocateImport })

  return { shadow: { source, file, tsx, map }, diagnostics }
}

// Declares the check-only helpers generated code calls, and the routes and public files links are checked against.
function environment(patterns: string[], files: string[]): string {
  const routes = patterns.length > 0 ? patterns.map(routeTuple).join(' | ') : 'never'
  const paths = files.length > 0 ? files.map(file => JSON.stringify(file)).join(' | ') : 'never'

  return [
    'import type { Action, CheckedHref, FieldName, IslandProp } from \'kay\'',
    '',
    'declare module \'kay\' {',
    `  interface Register { routes: ${routes}, files: ${paths} }`,
    '}',
    '',
    'declare global {',
    '  function KayHref<const Href extends string>(href: Href & CheckedHref<Href>): string',
    '  function KayField<Target extends string | Action<never, unknown>>(target: Target, name: FieldName<Target>): string',
    '  function KayProp<Component>(component: Component): <Value>(value: Value & IslandProp<Component, Value>) => Value',
    '}',
    '',
  ].join('\n')
}

// `/todos/:id` becomes `['todos', ':']`, the shape `CheckedHref` matches paths against segment by segment.
function routeTuple(pattern: string): string {
  const segments = pattern.split('/').filter(segment => segment !== '').map(segment => segment.startsWith(':') ? ':' : segment)

  return `[${segments.map(segment => JSON.stringify(segment)).join(', ')}]`
}

// Type-checks a project, .kay components included, and reports every error at the line and column the user wrote.
export async function check(root: string, options: CheckOptions = {}): Promise<CheckDiagnostic[]> {
  const tsconfig = options.tsconfig ?? 'tsconfig.json'
  const { files, diagnostics } = await writeShadowTypes(root, options)
  const child = Bun.spawn([process.execPath, TSGO, '--noEmit', '--pretty', 'false', '-p', tsconfig], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const config = resolve(root, tsconfig)
  const reported = parseTscOutput(output, config, root)

  if (errors.trim() !== '')
    diagnostics.push({ file: config, line: 1, column: 1, message: errors.trim() })

  for (const diagnostic of reported)
    diagnostics.push(remap(diagnostic, files))

  // A failing run that reported nothing must not pass for a clean one.
  if (code !== 0 && reported.length === 0 && errors.trim() === '')
    diagnostics.push({ file: config, line: 1, column: 1, message: `tsgo exited with code ${code} and no diagnostics` })

  return diagnostics
}

function parseTscOutput(output: string, config: string, root: string): CheckDiagnostic[] {
  const diagnostics: CheckDiagnostic[] = []

  for (const line of output.split('\n')) {
    const match = TSC_LINE.exec(line)

    if (match) {
      diagnostics.push({ file: resolve(root, match[1]!), line: Number(match[2]), column: Number(match[3]), code: match[4], message: match[5]! })

      continue
    }

    const global = TSC_GLOBAL_LINE.exec(line)

    if (global) {
      diagnostics.push({ file: config, line: 1, column: 1, code: global[1], message: global[2]! })

      continue
    }

    const last = diagnostics.at(-1)

    if (last && line.trim() !== '')
      last.message += `\n${line}`
  }

  return diagnostics
}

function remap(diagnostic: CheckDiagnostic, files: Map<string, ShadowFile>): CheckDiagnostic {
  const shadow = files.get(diagnostic.file)

  if (!shadow)
    return diagnostic

  const generated = offsetAt(shadow.tsx, diagnostic)
  const source = shadow.map.toSource(generated) ?? 0

  return { ...diagnostic, file: shadow.file, ...positionAt(shadow.source, source) }
}

// Followed by a code frame when the file's source is given.
export function formatCheckDiagnostic(diagnostic: CheckDiagnostic, source?: string): string {
  const code = diagnostic.code ? ` ${diagnostic.code}` : ''
  const heading = `${relative(process.cwd(), diagnostic.file)}:${diagnostic.line}:${diagnostic.column} - error${code}: ${diagnostic.message}`

  return source === undefined ? heading : `${heading}\n${codeFrame(source, offsetAt(source, diagnostic))}`
}

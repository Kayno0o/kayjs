import type { Diagnostic } from '../compiler/ast'
import type { Paint } from '../compiler/frame'
import type { InternalConfig, KayConfig, LoadedConfig } from '../config'
import type { TypeScope } from './diagnose'
import type { ProbeMemory } from './project'
import type { ShadowFile } from './shadow'
import type { ExtensionProgram } from './shadow-types'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { inWalkScope, readText } from '../build/files'
import { inAnalysisScope } from '../compiler'
import { formatReport } from '../compiler/frame'
import { lintLevels } from '../compiler/lints'
import { offsetAt, positionAt } from '../compiler/mapping'
import { pickConfig } from '../config'
import { projectPaths } from '../project'
import { diagnoseShadow, reportsTypeErrors, servedByTheApp, shownOutsideKay, unusedCodesOf } from './diagnose'
import { unknownNameHelp } from './export-homes'
import { CONTENT_CHECK, generatedProblem } from './generated'
import { configProblems, contentChecks, lintConfigTypeError, projectProblems, withoutMissingCaptcha } from './project'
import { writeShadowTypes } from './shadow-types'
import { parseTscOutput, resolvedConfig, tsgoCode, tsgoDiagnostic, typecheck } from './tsgo'

export { nativeExe } from '../compiler/native-typescript'
export { applySafeFixes } from './fixes'
export { generatedChecks, generatedProblem } from './generated'
export type { ProbeMemory } from './project'
export { configProblems, contentChecks, projectProblems, stopProbes } from './project'
export type { ContentChecks } from './project'
export { writeShadowTypes } from './shadow-types'
export type { ShadowTypes } from './shadow-types'

// The keys of the config `kay check` reads, which `configCheckOptions` passes on as written.
export const CHECK_CONFIG = [
  // The server entry relative to the root, `src/server.ts` by default: the `app` it exports types `ctx.locals` and the app routes links may point at.
  'entry',
  // Page directory relative to the root, so `ctx.params` is typed per route.
  'routesDir',
  // The libraries whose routes the app mounts, which links may point at too.
  'extensions',
  // Public file directory relative to the root, whose files links may point at.
  'publicDir',
  // API directory relative to the root, whose modules' GET routes links may point at, and where they are mounted, `/api` by default.
  'apiDir',
  'apiPath',
  // The app's own modules for its libraries' settings, checked against the defaults they replace.
  'librarySettings',
  // The content config relative to the root, whose collections' entries are read against their schemas.
  'contentConfig',
  // The config's redirects, whose targets on the site must be a page or a public file.
  'redirects',
  // Where the site is mounted, the origin it is public at and how long a stopping server waits, which the server refuses at boot when it cannot read them.
  'base',
  'site',
  'shutdownTimeout',
  // The settings with a value the server refuses at boot when it cannot read it.
  'health',
  'live',
  'requestIdHeader',
  'timeZone',
  'budget',
  // The config's locales: links may carry their prefixes, `t()` reads the default locale's messages, and every other locale's must match them.
  'i18n',
  // The site's one language without `i18n`: `t()` reads its extensions' catalogs and the app's then.
  'lang',
  // The level of each lint, over its default.
  'lints',
  // What a public site's head starts from, which the `seo` lints read, its favicon, and the maskable icon checked with it.
  'seo',
  'favicon',
  'manifest',
  // Where `images.card.logo` is checked as the boot draws it.
  'images',
  // Reports each route of the app no guard covers, which the server refuses.
  'requireGuards',
  // Reports the actions offered as tools that bot protection alone stands before.
  'mcp',
  // Where the OpenAPI document and its reference page are served, which links to them are checked against.
  'openapi',
] as const satisfies readonly (keyof KayConfig)[]

export interface CheckOptions extends Pick<KayConfig, (typeof CHECK_CONFIG)[number]>, InternalConfig {
  tsconfig?: string | undefined
  // The tree alone is wanted, as `kay dev` writes it: the diagnostics only `kay check` reports are not looked for.
  typesOnly?: boolean | undefined
  // Whether to report the lints of what a site lacks before it goes public, as `kay build` and `kay check --only seo` do.
  launch?: boolean | undefined
  // Set by `kay build --static`: a static host reads no `SITE_URL` once built, so a missing site is reported.
  exported?: boolean | undefined
}

export interface CheckDiagnostic extends Pick<Diagnostic, 'label' | 'related' | 'note' | 'help' | 'severity' | 'fixes'> {
  file: string
  line: number
  column: number
  // Where the span ends in the file's source, when it is longer than one character.
  end?: number | undefined
  message: string
  code?: string | undefined
  // Found by type checking only, so the file's type errors are still reported.
  checkOnly?: boolean | undefined
}

// A name nothing declares gets the module of kay that exports it, unless the diagnostic already carries a hint.
function helped({ message, help }: CheckDiagnostic): Pick<CheckDiagnostic, 'help'> {
  const found = help === undefined ? unknownNameHelp(message) : undefined

  return found === undefined ? {} : { help: found }
}

// The loaded config's `publicEnv` goes along, as no app key: `kay check` claims `/_kay/env.js` when it is set.
export function configCheckOptions(config: LoadedConfig): CheckOptions {
  return { ...pickConfig(config, CHECK_CONFIG), ...config.publicEnv !== undefined && { publicEnv: config.publicEnv } }
}

// Type-checks a project, .kay components included, and reports every error at the line and column the user wrote.
export async function check(root: string, options: CheckOptions = {}, probes?: ProbeMemory): Promise<CheckDiagnostic[]> {
  return inWalkScope(async () => inAnalysisScope(async () => runCheck(root, options, probes)))
}

async function runCheck(root: string, given: CheckOptions, probes?: ProbeMemory): Promise<CheckDiagnostic[]> {
  const options = await withoutMissingCaptcha(root, given)
  const tsconfig = options.tsconfig ?? 'tsconfig.json'
  // The props entries give their components are typed with the rest, so the collections are read before the type check; their probe does not wait for the shadow tree, which leaves the file it writes alone.
  // The tsconfig includes the shadow tree, so its files are listed once the tree is written.
  const contentFile = join(projectPaths(root).types, CONTENT_CHECK)
  const props = await readText(contentFile)
  const reading = contentChecks(root, options, probes)
  const shadowing = shadowedConfig(root, tsconfig, options)
  // Where the last run left the props check, tsgo types the project while the collections are read, and again once they have changed it, which costs a second run after the first ends.
  const speculative = props === undefined ? undefined : (async () => typecheck(root, tsconfig, (await shadowing)[1]))()
  // Everything but the feeds waits for nothing the probe reads.
  const problemsRun = (async () => projectProblems(root, options, reading, probes, (await shadowing)[0].served))()
  // Settled, so neither ends in a rejection nothing awaits.
  const started = Promise.allSettled([speculative, problemsRun])
  let content: Awaited<typeof reading>
  let types: Awaited<typeof shadowing>[0]
  let shown: Awaited<typeof shadowing>[1]

  try {
    [content, [types, shown]] = await Promise.all([reading, shadowing])
  }
  catch (error) {
    // What was started is left to end, not to fail unseen.
    await started

    throw error
  }

  const { files, diagnostics, unreached, libraries, mounts, locales, programs } = types
  const projectUnused = unusedCodesOf(shown)
  const typed = async () => {
    if (speculative === undefined)
      return typecheck(root, tsconfig, shown)

    if (await readText(contentFile) === props)
      return speculative

    // Typed against the props check the collections replaced, so it ends before the second run uses the same state.
    await Promise.allSettled([speculative])

    return typecheck(root, tsconfig, shown)
  }
  // An extension whose options differ from the app's is checked apart, so its pages are typed as it is written for.
  const [{ output, errors, code }, problems, ...apart] = await Promise.all([typed(), problemsRun, ...programs.map(async program => runProgram(root, program))])
  const config = resolve(root, tsconfig)
  const inProgram = (file: string) => programs.some(({ dir }) => file.startsWith(dir + sep))
  const printed = parseTscOutput(output, config, root)
  const reported = printed.filter(diagnostic => !inProgram(diagnostic.file))
  const scope: TypeScope = { root, broken: new Set(diagnostics.filter(diagnostic => !diagnostic.checkOnly).map(diagnostic => diagnostic.file)), unreached, libraries }
  const levels = new Map<ShadowFile, ReturnType<typeof lintLevels>>()
  const levelsOf = (shadow: ShadowFile) => {
    const levelAt = levels.get(shadow) ?? lintLevels(shadow.source, options.lints)

    levels.set(shadow, levelAt)

    return levelAt
  }

  diagnostics.push(...configProblems(root, options, types))

  if (errors.trim() !== '')
    diagnostics.push({ file: config, line: 1, column: 1, message: errors.trim() })

  for (const program of apart) {
    if (program.errors.trim() !== '')
      diagnostics.push({ file: program.tsconfig, line: 1, column: 1, message: program.errors.trim() })

    // The app's own files and the packages' modules are checked in the app's program, what a program reads of them only for its types.
    reported.push(...parseTscOutput(program.output, program.tsconfig, root).filter(diagnostic => diagnostic.file.startsWith(program.dir + sep)))

    if (program.code !== 0 && program.output.trim() === '' && program.errors.trim() === '')
      diagnostics.push({ file: program.tsconfig, line: 1, column: 1, message: `bun check exited with code ${program.code} and no diagnostics` })
  }

  // A template expression the shadow code writes twice, as a `match` subject, is mistyped twice in one place.
  const seen = new Set<string>()

  for (const diagnostic of reported) {
    if (lintConfigTypeError(root, options.lints, diagnostic))
      continue

    const shadow = files.get(diagnostic.file)
    const diagnosed = shadow && diagnoseShadow(shadow, tsgoDiagnostic(diagnostic, shadow.tsx), levelsOf(shadow))

    if (shadow ? !diagnosed : !shownOutsideKay(tsgoCode(diagnostic), projectUnused))
      continue

    const mapped: CheckDiagnostic = shadow && diagnosed
      ? { ...diagnostic, file: shadow.file, ...positionAt(shadow.source, diagnosed.span?.start ?? 0), code: diagnosed.code ?? diagnostic.code, severity: diagnosed.severity, message: diagnosed.message, note: diagnosed.note, help: diagnosed.help }
      : { ...diagnostic, ...helped(diagnostic) }
    const generated = generatedProblem(root, mapped, types, content)

    if (generated)
      diagnostics.push(generated)
    else if (reportsTypeErrors(mapped.file, scope) && !servedByTheApp(mapped.file, mapped.message, mounts, locales) && !seen.has(JSON.stringify([mapped.file, mapped.line, mapped.column, mapped.code, mapped.message])))
      diagnostics.push(mapped)

    seen.add(JSON.stringify([mapped.file, mapped.line, mapped.column, mapped.code, mapped.message]))
  }

  diagnostics.push(...problems)

  // A failing run that reported nothing must not pass for a clean one.
  if (code !== 0 && printed.length === 0 && errors.trim() === '')
    diagnostics.push({ file: config, line: 1, column: 1, message: `bun check exited with code ${code} and no diagnostics` })

  return diagnostics
}

async function shadowedConfig(root: string, tsconfig: string, options: CheckOptions) {
  const types = await writeShadowTypes(root, options)

  return [types, await resolvedConfig(root, tsconfig)] as const
}

// One extension program's type check, state kept apart from the app's and the other programs'.
async function runProgram(root: string, { dir, tsconfig }: ExtensionProgram) {
  const { output, errors, code } = await typecheck(root, tsconfig, await resolvedConfig(root, tsconfig), `extension-${Bun.hash(dir).toString(36)}`)

  return { dir, tsconfig, output, errors, code }
}

// With a code frame when the file's source is given.
export function formatCheckDiagnostic(diagnostic: CheckDiagnostic, source?: string, paint?: Paint): string {
  const start = source === undefined ? 0 : offsetAt(source, diagnostic)
  const frame = source === undefined ? undefined : { source, start, end: diagnostic.end ?? start + 1 }

  return formatReport({ ...diagnostic, file: relative(process.cwd(), diagnostic.file), frame }, paint)
}

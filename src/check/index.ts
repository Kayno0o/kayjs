import type { Diagnostic } from '../compiler/ast'
import type { Paint } from '../compiler/frame'
import type { LintLevels } from '../compiler/lints'
import type { FaviconConfig, I18nConfig, ImagesConfig, KayConfig, KayExtension, ManifestConfig, SeoConfig } from '../config'
import type { Duration } from '../runtime/duration'
import type { EnvSchema } from '../server/env'
import type { Redirects } from '../server/redirects'
import type { TypeScope } from './diagnose'
import type { ShadowFile } from './shadow'
import type { ExtensionProgram } from './shadow-types'
import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { formatReport } from '../compiler/frame'
import { lintLevels } from '../compiler/lints'
import { offsetAt, positionAt } from '../compiler/mapping'
import { diagnoseShadow, reportsTypeErrors, servedByTheApp, shownOutsideKay, unusedCodesOf } from './diagnose'
import { generatedProblem } from './generated'
import { configProblems, contentChecks, lintConfigTypeError, projectProblems } from './project'
import { writeShadowTypes } from './shadow-types'
import { parseTscOutput, resolvedConfig, tsgoCode, tsgoDiagnostic, typecheck } from './tsgo'

export { applySafeFixes } from './fixes'
export { generatedChecks, generatedProblem } from './generated'
export type { ProbeMemory } from './project'
export { configProblems, contentChecks, projectProblems, stopProbes } from './project'
export type { ContentChecks } from './project'
export { writeShadowTypes } from './shadow-types'
export type { ShadowTypes } from './shadow-types'
export { TSGO } from './tsgo'

export interface CheckOptions {
  tsconfig?: string | undefined
  // The server entry relative to the root, `src/server.ts` by default: the `app` it exports types `ctx.locals` and the app routes links may point at.
  entry?: string | undefined
  // Page directory relative to the root, so `ctx.params` is typed per route.
  routes?: string | undefined
  // The libraries whose routes the app mounts, which links may point at too.
  extensions?: KayExtension[] | undefined
  // Public file directory relative to the root, whose files links may point at.
  publicDir?: string | undefined
  // API directory relative to the root, whose modules' GET routes links may point at.
  api?: string | undefined
  // The app's own modules for its libraries' settings, checked against the defaults they replace.
  settings?: Record<string, string> | undefined
  // The content config relative to the root, whose collections' entries are read against their schemas.
  content?: string | undefined
  // The config's redirects, whose targets on the site must be a page or a public file.
  redirects?: Redirects | undefined
  // Where the site is mounted, the origin it is public at and how long a stopping server waits, which the server refuses at boot when it cannot read them.
  base?: string | undefined
  site?: string | undefined
  shutdownTimeout?: Duration | undefined
  // The config's locales: links may carry their prefixes, `t()` reads the default locale's messages, and every other locale's must match them.
  i18n?: I18nConfig | undefined
  // The site's one language without `i18n`: `t()` reads its extensions' catalogs and the app's then.
  lang?: string | undefined
  // The level of each lint, over its default.
  lints?: LintLevels | undefined
  // What a public site's head starts from, which the `seo` lints read.
  seo?: SeoConfig | undefined
  favicon?: string | FaviconConfig | false | undefined
  // Its maskable icon, checked with the favicon.
  manifest?: ManifestConfig | undefined
  // Where `images.card.logo` is checked as the boot draws it.
  images?: ImagesConfig | undefined
  publicEnv?: EnvSchema | undefined
  // Reports each route of the app no guard covers, which the server refuses.
  requireGuards?: boolean | undefined
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

export function configCheckOptions(config: KayConfig): CheckOptions {
  const { routes, publicDir, api, content, redirects, i18n, lang, settings, base, site, shutdownTimeout, lints, extensions, seo, favicon, manifest, images, publicEnv, requireGuards } = config

  return { routes, publicDir, api, content, redirects, i18n, lang, settings, base, site, shutdownTimeout, lints, extensions, seo, favicon, manifest, images, publicEnv, requireGuards }
}

// Type-checks a project, .kay components included, and reports every error at the line and column the user wrote.
export async function check(root: string, options: CheckOptions = {}): Promise<CheckDiagnostic[]> {
  const tsconfig = options.tsconfig ?? 'tsconfig.json'
  const types = await writeShadowTypes(root, options)
  const { files, diagnostics, unreached, libraries, mounts, locales, programs } = types
  // The props entries give their components are typed with the rest, so the collections are read first.
  const content = await contentChecks(root, options)
  const shown = await resolvedConfig(root, tsconfig)
  const projectUnused = unusedCodesOf(shown)
  // An extension whose options differ from the app's is checked apart, so its pages are typed as it is written for.
  const [{ output, errors, code }, problems, ...apart] = await Promise.all([typecheck(root, tsconfig, shown), projectProblems(root, options, content), ...programs.map(async program => runProgram(root, program))])
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
      diagnostics.push({ file: program.tsconfig, line: 1, column: 1, message: `tsgo exited with code ${program.code} and no diagnostics` })
  }

  for (const diagnostic of reported) {
    if (lintConfigTypeError(root, options.lints, diagnostic))
      continue

    const shadow = files.get(diagnostic.file)
    const diagnosed = shadow && diagnoseShadow(shadow, tsgoDiagnostic(diagnostic, shadow.tsx), levelsOf(shadow))

    if (shadow ? !diagnosed : !shownOutsideKay(tsgoCode(diagnostic), projectUnused))
      continue

    const remapped: CheckDiagnostic = shadow && diagnosed
      ? { ...diagnostic, file: shadow.file, ...positionAt(shadow.source, diagnosed.span?.start ?? 0), code: diagnosed.code ?? diagnostic.code, severity: diagnosed.severity, message: diagnosed.message, note: diagnosed.note, help: diagnosed.help }
      : diagnostic
    const generated = generatedProblem(root, remapped, types, content)

    if (generated)
      diagnostics.push(generated)
    else if (reportsTypeErrors(remapped.file, scope) && !servedByTheApp(remapped.file, remapped.message, mounts, locales))
      diagnostics.push(remapped)
  }

  diagnostics.push(...problems)

  // A failing run that reported nothing must not pass for a clean one.
  if (code !== 0 && printed.length === 0 && errors.trim() === '')
    diagnostics.push({ file: config, line: 1, column: 1, message: `tsgo exited with code ${code} and no diagnostics` })

  return diagnostics
}

// One extension program's tsgo run, state kept apart from the app's and the other programs'.
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

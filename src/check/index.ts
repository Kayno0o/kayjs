import type { Diagnostic } from '../compiler/ast'
import type { Paint } from '../compiler/frame'
import type { LintLevels } from '../compiler/lints'
import type { FaviconConfig, I18nConfig, ImagesConfig, KayConfig, KayExtension, ManifestConfig, SeoConfig } from '../config'
import type { Duration } from '../runtime/duration'
import type { EnvSchema } from '../server/env'
import type { Redirects } from '../server/redirects'
import type { TypeScope } from './diagnose'
import type { ShadowFile } from './shadow'
import { relative, resolve } from 'node:path'
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
  const { files, diagnostics, unreached, libraries, mounts, locales } = types
  // The props entries give their components are typed with the rest, so the collections are read first.
  const content = await contentChecks(root, options)
  const shown = await resolvedConfig(root, tsconfig)
  const projectUnused = unusedCodesOf(shown)
  const [{ output, errors, code }, problems] = await Promise.all([typecheck(root, tsconfig, shown), projectProblems(root, options, content)])
  const config = resolve(root, tsconfig)
  const reported = parseTscOutput(output, config, root)
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
  if (code !== 0 && reported.length === 0 && errors.trim() === '')
    diagnostics.push({ file: config, line: 1, column: 1, message: `tsgo exited with code ${code} and no diagnostics` })

  return diagnostics
}

// With a code frame when the file's source is given.
export function formatCheckDiagnostic(diagnostic: CheckDiagnostic, source?: string, paint?: Paint): string {
  const start = source === undefined ? 0 : offsetAt(source, diagnostic)
  const frame = source === undefined ? undefined : { source, start, end: diagnostic.end ?? start + 1 }

  return formatReport({ ...diagnostic, file: relative(process.cwd(), diagnostic.file), frame }, paint)
}

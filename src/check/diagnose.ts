// What kay makes of a diagnostic tsgo reports, the same in `kay check` and in the editor: dropped, or with its code, severity, message, help and place in the .kay source.
import type { KayLibrary } from '../build/libraries'
import type { Span } from '../compiler/ast'
import type { LintLevel, LintName } from '../compiler/lints'
import type { I18nConfig } from '../config'
import type { RouteMount } from '../server/routes'
import type { ShadowFile } from './shadow'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { libraryOf, packageRoot } from '../build/libraries'
import { typeLint } from '../compiler/lints'
import { WRITABLE } from '../compiler/names'
import { UNSERVED_MESSAGE } from '../runtime/checks'
import { localePrefixes, localeSettings } from '../server/i18n'
import { sourceSpan } from './shadow'

// What `noUnusedLocals` reports: `kay check` turns it on for .kay files, and leaves other files to the project's tsconfig.
const UNUSED_CODES = new Set([6133, 6192, 6196, 6198, 6199, 6205])
// What `noUnusedParameters` alone reports: a parameter, a destructured one or a type parameter, under the codes locals share.
const UNUSED_PARAMETER_CODES = new Set([6133, 6198, 6205])
// A condition that is always true, a function standing in for its value.
const ALWAYS_DEFINED = 2774
const MISSING_PROPERTY = 2339
const LEADING_NAME = /^[a-z_$][\w$]*/i
const MEMBER_OF = /([a-z_$][\w$]*)\??\.$/i
const KAY_FILE = /\.kay$/
// The error `CheckedHref` gives a site-relative path nothing serves.
const UNSERVED = new RegExp(`${UNSERVED_MESSAGE} (/[^"'\`;\\s]*)`)

// What tsgo reports, at offsets into the file it read.
export interface TsgoDiagnostic {
  code: number | undefined
  message: string
  start: number
  end: number
}

export interface Diagnosed {
  // A lint's own, standing for tsgo's code.
  code?: LintName
  // A lint's level; tsgo's own severity otherwise.
  severity?: 'error' | 'warning'
  message: string
  note?: string
  help?: string
  // Where the .kay source has it, undefined where nothing there stands for it.
  span: Span | undefined
  // Code nothing reads, which an editor fades.
  unread?: true
}

// Where kay reports type errors, as `kay check` knows the project.
export interface TypeScope {
  root: string
  // Files that did not compile: they have their errors already, and what tsgo makes of the code compiled around them would only add noise.
  broken: Set<string>
  // Library components the app never imports.
  unreached: Set<string>
  libraries: KayLibrary[]
}

// A diagnostic in a .kay file's shadow TSX, read at the levels its source gives the lints.
export function diagnoseShadow(shadow: ShadowFile, diagnostic: TsgoDiagnostic, levelAt: (lint: LintName, offset: number) => LintLevel): Diagnosed | undefined {
  const span = sourceSpan(shadow, diagnostic.start, diagnostic.end, 'loose')
  const offset = span?.start ?? 0
  const lint = typeLint(diagnostic.message)

  // A lint the types find, as `identity-key`.
  if (lint) {
    const level = levelAt(lint.code, offset)

    return level === 'allow' ? undefined : { ...lint, severity: severityOf(level), span }
  }

  // Unread code is the `unread-name` lint; a name kay generated, which the template reads in a way it does not spell out, is no code of the user's.
  if (diagnostic.code !== undefined && UNUSED_CODES.has(diagnostic.code)) {
    const level = shadow.map.isExact(diagnostic.start) ? levelAt('unread-name', offset) : 'allow'

    return level === 'allow' ? undefined : { code: 'unread-name', severity: severityOf(level), message: diagnostic.message, span, unread: true }
  }

  // An assignment to a name holding no signal, which kay wrote through `.set`.
  if (shadow.tsx.slice(diagnostic.start - WRITABLE.length, diagnostic.start) === WRITABLE)
    return { message: diagnostic.message, help: 'only a signal is written by assigning its name: a memo through the signals it derives from, and a plain value declared with `let`', span }

  return unreadSignal(diagnostic) ? { message: diagnostic.message, help: signalHelp(diagnostic, signalName(diagnostic, shadow.source, offset)), span } : { message: diagnostic.message, span }
}

// Outside .kay files, unused code is reported only when the project's tsconfig asks for it, as `--noUnusedLocals` is on for every file.
export function shownOutsideKay(code: number | undefined, projectUnused: Set<number>): boolean {
  return code === undefined || !UNUSED_CODES.has(code) || projectUnused.has(code)
}

// The unused codes the project's resolved tsconfig turns on.
export function unusedCodesOf(shown: string | undefined): Set<number> {
  if (shown === undefined)
    return new Set()

  const { compilerOptions } = JSON.parse(shown) as { compilerOptions?: { noUnusedLocals?: boolean, noUnusedParameters?: boolean } }

  return compilerOptions?.noUnusedLocals === true ? UNUSED_CODES : compilerOptions?.noUnusedParameters === true ? UNUSED_PARAMETER_CODES : new Set()
}

// A path an extension's routes name outside its own prefix, such as `/` to go back to the site, is the app's, which no extension can know: only a path into its own routes is checked, under a locale's prefix too.
export function servedByTheApp(file: string, message: string, mounts: RouteMount[], locales: string[]): boolean {
  const named = UNSERVED.exec(message)?.[1]

  if (named === undefined)
    return false

  const locale = locales.find(locale => named === `/${locale}` || named.startsWith(`/${locale}/`))
  const path = locale === undefined ? named : named.slice(locale.length + 1) || '/'

  const mount = mounts.find(({ dir }) => [dir, existsSync(dir) ? realpathSync(dir) : dir].some(root => file.startsWith(root + sep)))

  return mount !== undefined && (mount.prefix === '' || (path !== mount.prefix && !path.startsWith(`${mount.prefix}/`)))
}

// The prefixes the locales serve pages under, none where the config is one the server refuses, which `kay check` reports itself.
export function servedLocales(config: I18nConfig | undefined): string[] {
  try {
    return config ? localePrefixes(localeSettings(config)) : []
  }
  catch {
    return []
  }
}

// A library's own modules are its to check, as `skipLibCheck` leaves a declaration file's, a missing optional peer included: only its components compile as the app's. An app inside a linked library's repository keeps its own files, and a linked extension's package holds the modules it is the nearest package of and its dependencies', which leaves out the other packages beside it in a repository.
export function reportsTypeErrors(file: string, scope: TypeScope): boolean {
  const library = KAY_FILE.test(file) || ownFile(scope.root, file) ? undefined : libraryOf(scope.libraries, file)
  const libraryModule = library !== undefined && (library.extension !== true || [library.dir, library.realDir].some(dir => file.startsWith(dir + sep) && (packageRoot(dirname(file)) === dir || file.slice(dir.length).split(sep).includes('node_modules'))))

  return !scope.broken.has(file) && !scope.unreached.has(file) && !libraryModule
}

// A file of the project itself: under its root and outside every `node_modules`.
export function ownFile(root: string, file: string): boolean {
  const path = relative(resolve(root), file)

  return !path.startsWith('..') && !path.split(sep).includes('node_modules')
}

function severityOf(level: LintLevel): 'error' | 'warning' {
  return level === 'warn' ? 'warning' : 'error'
}

// A condition always true for a function, or a signal where its value goes: what a signal left uncalled gives.
function unreadSignal(diagnostic: TsgoDiagnostic): boolean {
  return diagnostic.code === ALWAYS_DEFINED || diagnostic.message.includes('\'Signal<')
}

// The signal the error is about where its position tells: the condition itself, or what a missing property was read on.
function signalName(diagnostic: TsgoDiagnostic, source: string, offset: number): string | undefined {
  if (diagnostic.code === ALWAYS_DEFINED)
    return LEADING_NAME.exec(source.slice(offset))?.[0]

  return diagnostic.code === MISSING_PROPERTY ? MEMBER_OF.exec(source.slice(0, offset))?.[1] : undefined
}

// A condition on any function is always true, a signal's or another's, so its help says so before naming signals.
function signalHelp(diagnostic: TsgoDiagnostic, name: string | undefined): string {
  const call = name === undefined ? 'calling it' : `calling it, \`${name}()\``

  return diagnostic.code === ALWAYS_DEFINED ? `a function is always true here, so its value is read by ${call}` : `a signal or memo is read by ${call}; handed on uncalled, as a prop or an argument, it passes the signal itself`
}

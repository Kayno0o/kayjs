// What kay's own libraries share with kay, for their server code, not API: free to change with any minor, as every library peers on kay's exact minor.

import type { Highlighter } from '../content/markdown'

export type { Highlighter }
export { underKayDev } from '../build/assets'
export type { KayCommand, Parsed } from '../commands/command'
export type { DataValue, JsonSchema } from '../content/edit'
export type { ToolResult } from '../mcp/protocol'
export { byteSize } from '../runtime/byte-size'
export type { ByteSize } from '../runtime/byte-size'
export { durationSeconds, optionMs } from '../runtime/duration'
export { durationWords } from '../runtime/duration-words'
export { isUrlAttribute, UNSAFE_ATTRIBUTE, UNSAFE_TAGS } from '../runtime/sanitize'
export { configuredSite } from '../runtime/site'
export { parseEvents } from '../runtime/sse'
export { acceptedLocales, matchLocale, validLocale } from './accept-language'
export { sourceHash } from './csp'
export { RESTART_RELOAD } from './dev'
export type { LocalizedEntry } from './entry-drafts'
export { escapeHtml } from './escape-html'
export { currentRequest } from './log'
export { actionTool } from './mcp'
export type { LibraryTool } from './mcp'
export type { MissingPath } from './not-found'
export { unansweredPaths } from './not-found'
export { nameUser, userOf } from './request-user'
export { READ_METHODS } from './routes'
export { addRuntimeRedirect, removeRuntimeRedirect, runtimeRedirects } from './runtime-redirect-api'
export { RedirectRefused } from './runtime-redirects'
export type { RuntimeRedirect } from './runtime-redirects'
export { GENERATE_SECRET, MIN_SECRET_LENGTH, openWith, sameText, sealWith, weakSecrets } from './seal'
export { stoppers } from './signals'
export type { MissingTranslations } from './translations'

type Translations = typeof import('./translations')
type Drafts = typeof import('./message-drafts')
type Entries = typeof import('./entry-drafts')

// Loaded on use: they pull Babel's parser and the content loader, which a library's server otherwise never needs.
export async function missingTranslations(...args: Parameters<Translations['missingTranslations']>): ReturnType<Translations['missingTranslations']> {
  return (await import('./translations')).missingTranslations(...args)
}

export async function writeDraftMessages(...args: Parameters<Drafts['writeDraftMessages']>): ReturnType<Drafts['writeDraftMessages']> {
  return (await import('./message-drafts')).writeDraftMessages(...args)
}

export async function localizedEntry(...args: Parameters<Entries['localizedEntry']>): ReturnType<Entries['localizedEntry']> {
  return (await import('./entry-drafts')).localizedEntry(...args)
}

export async function writeDraftEntry(...args: Parameters<Entries['writeDraftEntry']>): ReturnType<Entries['writeDraftEntry']> {
  return (await import('./entry-drafts')).writeDraftEntry(...args)
}

// The highlighter `kay.config.ts`'s `markdown.highlight` sets, which a library highlights code with as the app's Markdown does; undefined when the app has none.
export async function configuredHighlighter(): Promise<Highlighter | undefined> {
  return (await import('../content/load')).markdownOf({}).highlight
}

// The project root the running server serves: where `.kay` sits, and the content config's project, not the working directory a server may be started from.
export async function serverRoot(): Promise<string> {
  return (await import('../content/load')).contentPlace().root
}

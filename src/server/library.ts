// What kay's own libraries share with kay, for their server code, not API: free to change with any minor, as every library peers on kay's exact minor.

export { underKayDev } from '../build/assets'
export type { KayCommand, Parsed } from '../commands/command'
export type { ToolResult } from '../mcp/protocol'
export { durationSeconds } from '../runtime/duration'
export { isUrlAttribute, UNSAFE_ATTRIBUTE, UNSAFE_TAGS } from '../runtime/sanitize'
export { configuredSite } from '../runtime/site'
export { parseEvents } from '../runtime/sse'
export { acceptedLocales, matchLocale, validLocale } from './accept-language'
export { sourceHash } from './csp'
export { RESTART_RELOAD } from './dev'
export { escapeHtml } from './escape-html'
export { currentRequest } from './log'
export { actionTool } from './mcp'
export type { LibraryTool } from './mcp'
export { READ_METHODS } from './routes'
export { GENERATE_SECRET, MIN_SECRET_LENGTH, openWith, sameText, sealWith, weakSecrets } from './seal'
export { stoppers } from './signals'
export type { MissingTranslations } from './translations'

type Translations = typeof import('./translations')
type Drafts = typeof import('./message-drafts')

// Loaded on use: they pull Babel's parser and the content loader, which a library's server otherwise never needs.
export async function missingTranslations(...args: Parameters<Translations['missingTranslations']>): ReturnType<Translations['missingTranslations']> {
  return (await import('./translations')).missingTranslations(...args)
}

export async function writeDraftMessages(...args: Parameters<Drafts['writeDraftMessages']>): ReturnType<Drafts['writeDraftMessages']> {
  return (await import('./message-drafts')).writeDraftMessages(...args)
}

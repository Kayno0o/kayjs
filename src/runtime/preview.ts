import type { CompiledMarkdown } from '../content/markdown'
import type { DraftEntry } from './edit'
import type { FieldMarks } from './fields'

// What a request in preview mode carries while it renders: each loaded collection's entries, loaded once per request, and whether it is in edit mode.
export interface PreviewState {
  // Set for a visitor a share link let see one entry's draft alone: every other page and entry stays as published.
  scope?: PreviewScope
  loads: Map<unknown, Promise<unknown>>
  edit: boolean
  marks?: FieldMarks
  // The entries an editor has not saved yet, standing in for theirs, by the name each collection is loaded under.
  drafts?: Map<string, EntryDraft[]>
}

// A draft as the page renders it, its body compiled once, as `/_kay/draft` checked the components it uses.
export interface EntryDraft extends Omit<DraftEntry, 'collection'> {
  compiled?: CompiledMarkdown | undefined
}

// The entry a share link shows the draft of, its collection by name and its locale when the collection has them.
export interface PreviewScope {
  collection: string
  slug: string
  locale?: string | undefined
}

export type PreviewMode = 'preview' | 'edit'

// Set by the server, which knows whether the request being rendered is in preview mode; the browser never is.
let current: (() => PreviewState | undefined) | undefined

export function setPreviewScope(read: () => PreviewState | undefined): void {
  current = read
}

export function previewState(): PreviewState | undefined {
  return current?.()
}

// Whether the page renders for a visitor in preview mode, on the server: drafts show, and no prerendered or cached copy is read.
export function previewing(): boolean {
  const state = previewState()

  return state !== undefined && state.scope === undefined
}

// Whether the page renders for a visitor a share link let see this entry's draft, which stays hidden from every other visitor and entry.
export function sharedDraft(collection: string, slug: string, locale: string | undefined): boolean {
  const scope = previewState()?.scope

  return scope !== undefined && scope.collection === collection && scope.slug === slug && scope.locale === locale
}

// Whether the page renders for one visitor alone, past every cache: preview mode or a share link.
export function renderingForVisitor(): boolean {
  return previewState() !== undefined
}

// Whether the page renders for a visitor in edit mode, a CMS editing its content on the page: preview mode, its fields marked for the editor.
export function editing(): boolean {
  return previewState()?.edit === true
}

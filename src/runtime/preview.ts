import type { FieldMarks } from './fields'

// What a request in preview mode carries while it renders: each loaded collection's entries, loaded once per request, and whether it is in edit mode.
export interface PreviewState {
  loads: Map<unknown, Promise<unknown>>
  edit: boolean
  marks?: FieldMarks
  // The entries an editor has not saved yet, standing in for theirs, by the name each collection is loaded under.
  drafts?: Map<string, EntryDraft[]>
}

// An entry as an editor has it before saving: its data, and its Markdown body when it changed.
export interface EntryDraft {
  slug: string
  locale?: string | undefined
  data: unknown
  body?: string | undefined
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
  return previewState() !== undefined
}

// Whether the page renders for a visitor in edit mode, a CMS editing its content on the page: preview mode, its fields marked for the editor.
export function editing(): boolean {
  return previewState()?.edit === true
}

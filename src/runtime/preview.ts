// What a request in preview mode carries while it renders: each loaded collection's entries, loaded once per request.
export interface PreviewState {
  loads: Map<unknown, Promise<unknown>>
}

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

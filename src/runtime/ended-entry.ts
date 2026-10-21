// On the server, whether the page being rendered asked for an entry whose `unpublishAt` passed, so a not-found answer from it is a 410 Gone; set by the server, as nothing outside a request holds a page.
let note: (() => void) | undefined

export function setEndedEntryNote(next: () => void): void {
  note = next
}

export function noteEndedEntry(): void {
  note?.()
}

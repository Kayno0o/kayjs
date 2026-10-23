import type { EntryRef } from '../kay/contract'
import { signal } from 'kay'
import { entryKey } from '../markers'

// The entries of the page whose form has been opened, which stay open for as long as the editor lives so what was typed in them is kept.
const opened = signal<ReadonlySet<string>>(new Set())

export function isOpened(entry: EntryRef): boolean {
  return opened().has(entryKey(entry))
}

export function openEntry(entry: EntryRef): void {
  const key = entryKey(entry)

  if (!opened().has(key))
    opened.set(new Set(opened()).add(key))
}

// Back to rows, as the editor is left.
export function forgetOpened(): void {
  opened.set(new Set())
}

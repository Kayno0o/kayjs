import type { DraftEntry, DraftResult, EntryRef, Issue } from './kay/contract'
import type { FieldPath } from './markers'
import { signal } from 'kay'
import { BODY, entryKey } from './markers'
import { valueAt, withValueAt } from './paths'

export interface DraftsOptions {
  // Renders the page with these entries in place of the saved ones: kay's `showDraft`.
  show: (entries: DraftEntry[]) => Promise<DraftResult>
  // How long typing pauses before the page renders again, in milliseconds.
  delay?: number | undefined
}

export type Drafts = ReturnType<typeof createDrafts>

// The unsaved edits of the entries a page renders, rendering the page with them shortly after each change.
export function createDrafts({ show, delay = 150 }: DraftsOptions) {
  const saved = new Map<string, DraftEntry>()
  // The version of each entry's file its saved state was read from, which the next save names.
  const versions = new Map<string, string | undefined>()
  const current = signal<ReadonlyMap<string, DraftEntry>>(new Map())
  const issues = signal<readonly Issue[]>([])
  const failure = signal<string>()
  const rendering = signal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let latest = 0

  function changed(): DraftEntry[] {
    return [...current().entries()].filter(([key, entry]) => entry !== saved.get(key)).map(([, entry]) => entry)
  }

  function schedule(): void {
    clearTimeout(timer)
    timer = setTimeout(() => void render(), delay)
  }

  async function render(): Promise<void> {
    const call = ++latest

    rendering.set(true)

    try {
      const result = await show(changed())

      if (call === latest) {
        issues.set(result.issues ?? [])
        failure.set(undefined)
      }
    }
    catch (error) {
      // A render a newer one replaced, which kay aborts, no longer matters.
      if (call === latest)
        failure.set(error instanceof Error ? error.message : String(error))
    }
    finally {
      if (call === latest)
        rendering.set(false)
    }
  }

  function update(ref: EntryRef, change: (entry: DraftEntry) => DraftEntry | undefined): void {
    const key = entryKey(ref)
    const entry = current().get(key)

    if (!entry)
      throw new Error(`${key} was never opened`)

    const original = saved.get(key) as DraftEntry
    const next = change(entry)
    // An edit typed back to the saved text leaves the entry unchanged.
    const same = next === undefined || JSON.stringify(next) === JSON.stringify(original)

    current.set(new Map(current()).set(key, same ? original : next))
    schedule()
  }

  return {
    // Starts from the saved entry, unless it already has a draft.
    open(entry: DraftEntry, version?: string | undefined): void {
      const key = entryKey(entry)

      if (saved.has(key))
        return

      saved.set(key, entry)
      versions.set(key, version)
      current.set(new Map(current()).set(key, entry))
    },
    entry(ref: EntryRef): DraftEntry | undefined {
      return current().get(entryKey(ref))
    },
    version(ref: EntryRef): string | undefined {
      return versions.get(entryKey(ref))
    },
    value(ref: EntryRef, path: FieldPath): unknown {
      const entry = current().get(entryKey(ref))

      return path === BODY ? entry?.body : valueAt(entry?.data, path)
    },
    set(ref: EntryRef, path: FieldPath, value: unknown): void {
      update(ref, entry => path === BODY ? { ...entry, body: String(value) } : { ...entry, data: withValueAt(entry.data, path, value) })
    },
    changed(ref: EntryRef): boolean {
      const key = entryKey(ref)

      return current().get(key) !== saved.get(key)
    },
    // Drops the entry's unsaved edits, rendering the page without them.
    reset(ref: EntryRef): void {
      update(ref, () => undefined)
    },
    // Takes the entry as it was sent for its saved state, once a save went through: an edit made while it was on its way stays unsaved.
    markSaved(ref: EntryRef, sent: DraftEntry, version?: string | undefined): void {
      const key = entryKey(ref)

      saved.set(key, sent)
      versions.set(key, version)
      current.set(new Map(current()))
    },
    // Shows the issues a save was refused with, as a render's are shown.
    report(refusals: readonly Issue[]): void {
      issues.set(refusals)
    },
    // The schema's refusals of the last render or save, of the entry or of one of its fields.
    issues(ref: EntryRef, path?: FieldPath): Issue[] {
      const key = entryKey(ref)

      return issues().filter(issue => entryKey(issue) === key && (path === undefined || (path === BODY ? issue.body === true : issue.body !== true && issue.path === path)))
    },
    // Why the last render failed, other than the schema refusing it.
    failure: () => failure(),
    rendering: () => rendering(),
  }
}

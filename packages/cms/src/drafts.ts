import type { DurationText } from 'kay'
import type { DraftEntry, DraftResult, EntryRef, Issue } from './kay/contract'
import type { FieldPath } from './markers'
import { durationMs, signal } from 'kay'
import { BODY, entryKey } from './markers'
import { valueAt, withValueAt } from './paths'

export interface DraftsOptions {
  // Renders the page with these entries in place of the saved ones: kay's `showDraft`.
  show: (entries: DraftEntry[]) => Promise<DraftResult>
  // How long typing pauses before the page renders again, `'150ms'` by default.
  delay?: DurationText | undefined
}

export type Drafts = ReturnType<typeof createDrafts>

// Why the last save of an entry was refused as a whole, kept until it saves or its edits are dropped; `conflict` is the version another save left the file at.
export interface Refusal {
  message: string
  conflict?: { version: string | null } | undefined
}

// The unsaved edits of the entries a page renders, rendering the page with them shortly after each change.
export function createDrafts({ show, delay = '150ms' }: DraftsOptions) {
  const wait = durationMs(delay)
  const saved = new Map<string, DraftEntry>()
  // The version of each entry's file its saved state was read from, which the next save names.
  const versions = new Map<string, string | undefined>()
  // The entries whose file the other side deleted and whose edits were kept: their next save creates the file, and is refused if one was made meanwhile.
  const recreated = new Set<string>()
  const current = signal<ReadonlyMap<string, DraftEntry>>(new Map())
  const issues = signal<readonly Issue[]>([])
  const refusals = signal<ReadonlyMap<string, Refusal>>(new Map())
  const failure = signal<string>()
  const rendering = signal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let latest = 0
  // Set by a save's refusal, so a render scheduled before it leaves those issues be; the next edit clears it.
  let reported = false

  function changed(): DraftEntry[] {
    return [...current().entries()].filter(([key, entry]) => entry !== saved.get(key)).map(([, entry]) => entry)
  }

  function schedule(): void {
    reported = false
    clearTimeout(timer)
    timer = setTimeout(() => void render(), wait)
  }

  async function render(): Promise<void> {
    const call = ++latest

    rendering.set(true)

    try {
      const result = await show(changed())

      if (call === latest) {
        if (!reported)
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

  function refuse(ref: EntryRef, refusal: Refusal | undefined): void {
    const next = new Map(refusals())

    if (refusal)
      next.set(entryKey(ref), refusal)
    else
      next.delete(entryKey(ref))

    refusals.set(next)
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
      refuse(ref, undefined)
      recreated.delete(entryKey(ref))
      update(ref, () => undefined)
    },
    // Takes the entry as it was sent for its saved state, once a save went through: an edit made while it was on its way stays unsaved.
    markSaved(ref: EntryRef, sent: DraftEntry, version?: string | undefined): void {
      const key = entryKey(ref)

      saved.set(key, sent)
      versions.set(key, version)
      recreated.delete(key)
      current.set(new Map(current()))
      refuse(ref, undefined)
    },
    // Keeps why a save was refused as a whole, which no render replaces, or forgets it.
    refuse,
    refusal(ref: EntryRef): Refusal | undefined {
      return refusals().get(entryKey(ref))
    },
    // After a conflict, takes the version the other save left as the one the edits were made from, so the next save writes them over it.
    keepEdits(ref: EntryRef): void {
      const conflict = refusals().get(entryKey(ref))?.conflict

      if (!conflict)
        return

      versions.set(entryKey(ref), conflict.version ?? undefined)

      if (conflict.version === null)
        recreated.add(entryKey(ref))

      refuse(ref, undefined)
    },
    // Whether the entry's next save creates its file, its edits kept over a file deleted meanwhile.
    recreating(ref: EntryRef): boolean {
      return recreated.has(entryKey(ref))
    },
    // Shows the issues a save was refused with, as a render's are shown.
    report(refusals: readonly Issue[]): void {
      reported = true
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

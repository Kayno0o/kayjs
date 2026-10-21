import type { DurationText } from 'kay'
import type { DraftKeeper } from './draft-storage'
import type { DraftEntry, DraftResult, EntryRef, Issue } from './kay/contract'
import type { FieldPath } from './markers'
import { durationMs, signal } from 'kay'
import { BODY, entryKey } from './markers'
import { differing, valueAt, withValueAt } from './paths'
import { hashOf } from './room'

export interface DraftsOptions {
  // Renders the page with these entries in place of the saved ones: kay's `showDraft`.
  show: (entries: DraftEntry[]) => Promise<DraftResult>
  // How long typing pauses before the page renders again, `'150ms'` by default.
  delay?: DurationText | undefined
  // Where unsaved edits are kept across a reload, a crash and a second tab: `browserKeeper()`. None keeps them in memory only.
  keep?: DraftKeeper | undefined
}

// What a kept draft names the saved copy it was made from by, as the copy itself would double a Markdown body in the browser's storage.
function fingerprint(entry: DraftEntry): string {
  return hashOf(JSON.stringify([entry.data, entry.body ?? '']))
}

export type Drafts = ReturnType<typeof createDrafts>

// Why the last save of an entry was refused as a whole, kept until it saves or its edits are dropped; `conflict` is the version another save left the file at.
export interface Refusal {
  message: string
  conflict?: { version: string | null } | undefined
}

// What `open` found kept for an entry: when the edits were typed, and whether they came back (`restored`) or were left out because the entry was saved since.
export interface Recovery {
  at: number
  restored: boolean
}

// The unsaved edits of the entries a page renders, rendering the page with them shortly after each change.
export function createDrafts({ show, delay = '150ms', keep }: DraftsOptions) {
  const wait = durationMs(delay)
  const saved = new Map<string, DraftEntry>()
  // What `open` was last given for each entry, so being given it again changes nothing.
  const offered = new Map<string, string>()
  // Each saved entry as text, so an edit is compared with it by stringifying the edited entry alone.
  const savedText = new Map<string, string>()
  // The version of each entry's file its saved state was read from, which the next save names.
  const versions = new Map<string, string | undefined>()
  // The entries whose file the other side deleted and whose edits were kept: their next save creates the file, and is refused if one was made meanwhile.
  const recreated = new Set<string>()
  const current = signal<ReadonlyMap<string, DraftEntry>>(new Map())
  const issues = signal<readonly Issue[]>([])
  // The fields whose text cannot be turned into a value yet, by entry then field path: what the editor typed in a JSON box that does not parse. A save refuses until they are fixed, as the entry holds the last text that parsed.
  const unparsed = signal<ReadonlyMap<string, ReadonlyMap<string, string>>>(new Map())
  const refusals = signal<ReadonlyMap<string, Refusal>>(new Map())
  const recoveries = signal<ReadonlyMap<string, Recovery>>(new Map())
  const failure = signal<string>()
  const rendering = signal(false)
  // Whether an edit is typed whose render has not ended: the page still shows what it showed before.
  const waiting = signal(false)
  // The entries whose edits are typed but not yet written to the keeper: writing waits for the render's pause, since each write stringifies the whole entry.
  const unwritten = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let latest = 0
  // Set by a save's refusal, so a render scheduled before it leaves those issues be; the next edit clears it.
  let reported = false

  function keepSaved(key: string, entry: DraftEntry): void {
    saved.set(key, entry)
    savedText.set(key, JSON.stringify(entry))
  }

  function changed(): DraftEntry[] {
    return [...current().entries()].filter(([key, entry]) => entry !== saved.get(key)).map(([, entry]) => entry)
  }

  function schedule(): void {
    reported = false
    waiting.set(true)
    clearTimeout(timer)
    timer = setTimeout(() => {
      flush()
      void render()
    }, wait)
  }

  // Writes the edits typed since the last write.
  function flush(): void {
    for (const key of unwritten)
      persist(key)
  }

  async function render(): Promise<void> {
    const call = ++latest

    rendering.set(true)

    try {
      const result = await show(changed())

      if (call === latest) {
        // A render that names no issues, as a form with no preview, leaves the ones shown be: an edit has already dropped its own.
        if (!reported && result.issues !== undefined)
          issues.set(result.issues)

        failure.set(undefined)
      }
    }
    catch (error) {
      // A render a newer one replaced, which kay aborts, no longer matters.
      if (call === latest)
        failure.set(error instanceof Error ? error.message : String(error))
    }
    finally {
      if (call === latest) {
        rendering.set(false)
        waiting.set(false)
      }
    }
  }

  // Keeps the entry's edits where a reload finds them, or forgets them once it has none.
  function persist(key: string): void {
    unwritten.delete(key)

    const entry = current().get(key)
    const base = saved.get(key)

    if (!keep)
      return

    if (entry && entry !== base)
      keep.write(key, { entry, version: versions.get(key), at: keep.now(), ...versions.get(key) === undefined && base ? { base: fingerprint(base) } : {} })
    else
      keep.remove(key)
  }

  function recover(key: string, entry: DraftEntry, version: string | undefined): DraftEntry {
    const kept = keep?.read(key)

    if (!kept)
      return entry

    // Edits made from another version of the file would write over what was saved since. An entry with no version, a folder entry outside the repository, is told by the copy the edits were made from.
    const stale = kept.version !== version || (version === undefined && kept.base !== fingerprint(entry))
    const restored = !stale && JSON.stringify(kept.entry) !== JSON.stringify(entry)

    if (!restored)
      keep?.remove(key)

    if (stale || restored)
      recoveries.set(new Map(recoveries()).set(key, { at: kept.at, restored }))

    return restored ? kept.entry : entry
  }

  // Whether an edit of `path` answers the issue: its own, one on a field holding it, and the entry's as a whole.
  function answered(issue: Issue, key: string, path: FieldPath): boolean {
    if (entryKey(issue) !== key)
      return false

    if (path === BODY)
      return issue.body === true

    if (issue.body === true || issue.key !== undefined)
      return false

    return issue.path === path || issue.path === '' || path.startsWith(`${issue.path}.`)
  }

  // Drops the issues an edit answers, leaving every other field's shown.
  function dismiss(key: string, path: FieldPath): void {
    if (issues().some(issue => answered(issue, key, path)))
      issues.set(issues().filter(issue => !answered(issue, key, path)))
  }

  function block(key: string, path: string, message: string | undefined): void {
    const fields = new Map(unparsed().get(key))

    if (message === undefined)
      fields.delete(path)
    else
      fields.set(path, message)

    const next = new Map(unparsed())

    if (fields.size === 0)
      next.delete(key)
    else
      next.set(key, fields)

    unparsed.set(next)
  }

  function unblock(key: string): void {
    if (unparsed().has(key)) {
      const next = new Map(unparsed())

      next.delete(key)
      unparsed.set(next)
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
    const same = next === undefined || JSON.stringify(next) === savedText.get(key)

    current.set(new Map(current()).set(key, same ? original : next))

    // Dropping a draft is cheap and goes at once; keeping one waits for the pause.
    if (same)
      persist(key)
    else
      unwritten.add(key)

    schedule()
  }

  function forget(key: string): void {
    if (recoveries().has(key)) {
      const next = new Map(recoveries())

      next.delete(key)
      recoveries.set(next)
    }
  }

  return {
    // Starts from the saved entry, unless it already has a draft.
    open(entry: DraftEntry, version?: string | undefined): void {
      const key = entryKey(entry)

      const offer = `${version ?? ''}\n${JSON.stringify(entry)}`

      if (saved.has(key)) {
        // An entry offered again with a copy or version it was not offered before, as on returning to it, shows that copy with no edits; edits keep the version they were made from, so their save meets any conflict. The same offer again, as when an effect reruns, changes nothing, a save of this page's included.
        if (offered.get(key) !== offer && current().get(key) === saved.get(key)) {
          keepSaved(key, entry)
          versions.set(key, version)
          current.set(new Map(current()).set(key, entry))
        }

        offered.set(key, offer)

        return
      }

      offered.set(key, offer)

      const start = recover(key, entry, version)

      keepSaved(key, entry)
      versions.set(key, version)
      current.set(new Map(current()).set(key, start))

      if (start !== entry)
        schedule()
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
      // An edit answers its own field's issue only: the others still stand until their fields are edited too.
      dismiss(entryKey(ref), path)
      update(ref, entry => path === BODY ? { ...entry, body: String(value) } : { ...entry, data: withValueAt(entry.data, path, value) })
    },
    changed(ref: EntryRef): boolean {
      const key = entryKey(ref)

      return current().get(key) !== saved.get(key)
    },
    // Drops the entry's unsaved edits, rendering the page without them.
    reset(ref: EntryRef): void {
      forget(entryKey(ref))
      unblock(entryKey(ref))
      issues.set(issues().filter(issue => entryKey(issue) !== entryKey(ref)))
      refuse(ref, undefined)
      recreated.delete(entryKey(ref))
      update(ref, () => undefined)
    },
    // Takes the entry as it was sent for its saved state, once a save went through: an edit made while it was on its way stays unsaved.
    markSaved(ref: EntryRef, sent: DraftEntry, version?: string | undefined): void {
      const key = entryKey(ref)

      keepSaved(key, sent)
      versions.set(key, version)
      recreated.delete(key)
      current.set(new Map(current()))
      forget(key)
      persist(key)
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
      persist(entryKey(ref))

      if (conflict.version === null)
        recreated.add(entryKey(ref))

      refuse(ref, undefined)
    },
    // After a conflict, takes the entry as the other save left it, dropping the edits: its copy and version become the saved state.
    adopt(ref: EntryRef, entry: DraftEntry, version: string | undefined): void {
      const key = entryKey(ref)

      forget(key)
      unblock(key)
      recreated.delete(key)
      keepSaved(key, entry)
      versions.set(key, version)
      current.set(new Map(current()).set(key, entry))
      persist(key)
      refuse(ref, undefined)
      schedule()
    },
    // The fields both the entry's edits and `other` changed from the copy the edits were made from, a data field by its path and the body as `BODY`.
    differences(ref: EntryRef, other: DraftEntry): FieldPath[] {
      const key = entryKey(ref)
      const mine = current().get(key)
      const base = saved.get(key)

      if (!mine || !base)
        return []

      const theirs = new Set(differing(base, other))

      return differing(base, mine).filter(path => theirs.has(path))
    },
    // Whether any entry has edits not saved yet, among `shown` when given: the entries the editor shows, as edits of one the page left behind no longer ask a confirmation.
    anyChanged(shown?: readonly EntryRef[]): boolean {
      const keys = shown ? shown.map(entryKey) : [...current().keys()]

      return keys.some(key => current().has(key) && current().get(key) !== saved.get(key))
    },
    // Writes the edits not yet kept, as when the page is about to go.
    flush,
    // Drops the edits of every entry, rendering the page without them, and forgets what the browser kept.
    discardAll(): void {
      for (const [key, entry] of saved) {
        current.set(new Map(current()).set(key, entry))
        keep?.remove(key)
      }

      recreated.clear()
      unwritten.clear()
      unparsed.set(new Map())
      refusals.set(new Map())
      recoveries.set(new Map())
      // A draft of an entry this page never opened, left by a visit that ended without Stop editing, goes too: the edit cookie names no user.
      keep?.clear()
    },
    // What was found kept for the entry when it opened: restored edits, or edits left out for being older than the entry.
    recovery(ref: EntryRef): Recovery | undefined {
      return recoveries().get(entryKey(ref))
    },
    // Whether the entry's next save creates its file, its edits kept over a file deleted meanwhile.
    recreating(ref: EntryRef): boolean {
      return recreated.has(entryKey(ref))
    },
    // Renders the page again with the unsaved edits, once another page replaced the one they were last shown on; nothing to render while no entry has an edit.
    reapply(): void {
      if (changed().length > 0)
        schedule()
    },
    // The entries with unsaved edits the page does not show, as the schema refuses them: it shows their saved text instead, the other drafts still in place.
    stale(): EntryRef[] {
      const keys = new Set(issues().map(entryKey))

      return changed().filter(entry => keys.has(entryKey(entry)))
    },
    // Shows the issues a save was refused with, as a render's are shown.
    report(refusals: readonly Issue[]): void {
      reported = true
      issues.set(refusals)
    },
    // Drops one field's issues, such as the slug's of a new entry (`path` `''` with `key`), which no edit of the draft reaches.
    dismissWhere(ref: EntryRef, match: (issue: Issue) => boolean): void {
      issues.set(issues().filter(issue => entryKey(issue) !== entryKey(ref) || !match(issue)))
    },
    // Says a field's text cannot be turned into a value (a message), or that it can again (none).
    block(ref: EntryRef, path: string, message: string | undefined): void {
      block(entryKey(ref), path, message)
    },
    // The fields of the entry whose text does not parse, with why.
    blocked(ref: EntryRef, path?: string): { path: string, message: string }[] {
      return [...unparsed().get(entryKey(ref)) ?? []].filter(([at]) => path === undefined || at === path).map(([at, message]) => ({ path: at, message }))
    },
    // The schema's refusals of the last render or save, of the entry or of one of its fields.
    issues(ref: EntryRef, path?: FieldPath): Issue[] {
      const key = entryKey(ref)

      return issues().filter(issue => entryKey(issue) === key && (path === undefined || (path === BODY ? issue.body === true : issue.body !== true && issue.path === path)))
    },
    // Why the last render failed, other than the schema refusing it.
    failure: () => failure(),
    rendering: () => rendering(),
    pending: () => waiting(),
  }
}

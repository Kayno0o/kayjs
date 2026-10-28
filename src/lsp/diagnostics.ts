import type { Diagnostic as KayDiagnostic } from '../compiler'
import type { Span } from '../compiler/ast'
import type { Document, LspHost } from './host'
import type { DocumentDiagnosticReport } from './protocol'
import { basename, dirname, resolve } from 'node:path'
import { diagnoseShadow, reportsTypeErrors, servedByTheApp } from '../check/diagnose'
import { lintLevels } from '../compiler/lints'
import { projectRootOf } from '../project'
import { ERROR, guard, WARNING } from './host'
import { zeroRange } from './mapping'
import { toOffset, toPosition } from './positions'

// The module of an import or a re-export in a component's text, fence or template.
const IMPORT_SOURCE = /\b(?:from|import)\s*['"]([^'"]+)['"]/g
const EXTENSION = /\.\w+$/
const UNNECESSARY = 1
// How many of those are checked at once, so an edit coming meanwhile waits for few.
const DEPENDENTS_BATCH = 4

// How long a change waits for the next before the files are checked again, as typing makes many; the first after a quiet spell is checked at once.
export const DIAGNOSTICS_DELAY = 150
// How long the open files importing an edited one wait for the next edit before they are checked again, after the edited one is.
export const DEPENDENTS_DELAY = 750

export class DiagnosticsQueue {
  // The quiet spell since the last change, and whether another came during it, which publishes again once it ends.
  private diagnosticsTimer: Timer | undefined
  private diagnosticsDue = false
  // The files whose diagnostics wait to be published: those a change or a save reached, which go first, and the open files importing an edited one, which wait for a quiet spell of their own.
  private readonly urgent = new Set<string>()
  private readonly later = new Set<string>()
  private dependentsTimer: Timer | undefined
  // The run publishing them, one at a time: those asked for meanwhile join it, and see the latest text.
  private publishing: Promise<void> | undefined
  // Whether the run in flight takes the files of `later` too, which only the quiet spell after an edit asks for.
  private takesLater = false

  constructor(private readonly host: LspHost) {}

  // The given files, every open one when none are.
  scheduleDiagnostics(uris: Iterable<string> = this.host.documents.keys()) {
    for (const uri of uris) {
      this.later.delete(uri)
      this.urgent.add(uri)
    }

    if (this.diagnosticsTimer === undefined)
      void guard(this.publishQueued())
    else
      this.diagnosticsDue = true

    clearTimeout(this.diagnosticsTimer)
    this.diagnosticsTimer = setTimeout(() => {
      this.diagnosticsTimer = undefined

      if (this.diagnosticsDue) {
        this.diagnosticsDue = false
        void guard(this.publishQueued())
      }
    }, DIAGNOSTICS_DELAY)
  }

  // An edit can break the open files importing the edited one, directly or through another, and no other.
  // A file reaching it through a module that is not open waits for the next save, which checks them all.
  scheduleDependents(edited: Document) {
    const found = new Set<string>()

    const queue = [edited]

    for (const target of queue) {
      for (const document of this.host.documents.values()) {
        if (document !== edited && !found.has(document.uri) && importsFile(document, target.file)) {
          found.add(document.uri)
          queue.push(document)
        }
      }
    }

    for (const uri of found) {
      if (!this.urgent.has(uri))
        this.later.add(uri)
    }

    if (this.later.size === 0)
      return

    clearTimeout(this.dependentsTimer)
    this.dependentsTimer = setTimeout(() => void guard(this.publishQueued(true)), DEPENDENTS_DELAY)
  }

  // Every open file, checked again.
  async publishAllDiagnostics() {
    for (const uri of this.host.documents.keys())
      this.urgent.add(uri)

    await this.publishQueued()
  }

  // Publishes the files waiting, the urgent ones first and the rest a few at a time, one run at a time so a slow tsgo is not asked twice for a file; those asked for meanwhile join the run.
  async publishQueued(withLater = false): Promise<void> {
    this.takesLater ||= withLater
    this.publishing ??= this.publishRun()

    return this.publishing
  }

  private async publishRun() {
    // Past this the run is always stored before it ends.
    await Promise.resolve()

    let failure: { reason: unknown } | undefined

    try {
      for (let batch = this.nextBatch(); batch.length > 0; batch = this.nextBatch()) {
        // Settled, not rejected at the first failure, so none is still running when the next batch starts.
        const settled = await Promise.allSettled(batch.map(async (uri) => {
          const document = this.host.documents.get(uri)

          if (document)
            await this.publishDiagnostics(document)
        }))
        const failed = settled.find(result => result.status === 'rejected')

        failure ??= failed?.status === 'rejected' ? { reason: failed.reason } : undefined
      }
    }
    finally {
      this.publishing = undefined
      this.takesLater = false
    }

    if (failure)
      throw failure.reason
  }

  private nextBatch(): string[] {
    const waiting = this.takesLater ? [...this.later].slice(0, DEPENDENTS_BATCH) : []
    const batch = this.urgent.size > 0 ? [...this.urgent] : waiting

    for (const uri of batch) {
      this.urgent.delete(uri)
      this.later.delete(uri)
    }

    return batch
  }

  private async publishDiagnostics(document: Document) {
    const project = this.host.projectAt(projectRootOf(document.file, this.host.root))
    const rangeOf = (span: Span) => ({ start: toPosition(document.source, span.start), end: toPosition(document.source, Math.max(span.end, span.start + 1)) })
    // A library component the app never imports is the library's to check, as `kay check` leaves it.
    const reached = !project.unreached.has(document.file)
    const compileErrors = (reached ? document.diagnostics : []).map(diagnostic => ({
      range: rangeOf(diagnostic),
      severity: diagnostic.severity === 'warning' ? WARNING : ERROR,
      source: 'kay',
      ...diagnostic.code !== undefined && { code: diagnostic.code },
      message: editorMessage(diagnostic),
      ...diagnostic.related && { relatedInformation: diagnostic.related.map(span => ({ location: { uri: document.uri, range: rangeOf(span) }, message: span.label })) },
      ...diagnostic.code === 'unread-name' && { tags: [UNNECESSARY] },
    }))
    // A compile error leaves the shadow TSX half-written, so its type errors would only be noise; one found by type checking only leaves it whole. The rest of what `kay check` leaves out stays out here too.
    const broken = new Set(document.diagnostics.some(diagnostic => !diagnostic.checkOnly) ? [document.file] : [])
    const reports = reportsTypeErrors(document.file, { root: project.root, broken, unreached: project.unreached, libraries: project.libraries })
    const report = reports ? await this.host.server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument: { uri: document.shadowUri } }) : undefined

    if (this.host.documents.get(document.uri) !== document)
      return

    // Related information points into the shadow TSX, a file the user never sees. Each one reads as `kay check` reports it: unused code is the `unread-name` lint, which TypeScript only hints at without `noUnusedLocals`.
    const levelAt = lintLevels(document.source, project.options.lints)
    // A template expression the shadow code writes twice, as a `match` subject, is mistyped twice in one place.
    const seen = new Set<string>()
    const typeErrors = (report?.items ?? []).flatMap(({ relatedInformation: _related, ...diagnostic }) => {
      const start = toOffset(document.tsx, diagnostic.range.start)
      const diagnosed = diagnoseShadow(document, { code: typeof diagnostic.code === 'number' ? diagnostic.code : undefined, message: diagnostic.message, start, end: toOffset(document.tsx, diagnostic.range.end) }, levelAt)

      if (!diagnosed || servedByTheApp(document.file, diagnosed.message, project.mounts, project.locales))
        return []

      const key = JSON.stringify([diagnosed.span, diagnosed.code, diagnosed.message])

      if (seen.has(key))
        return []

      seen.add(key)

      return [{
        ...diagnostic,
        ...diagnosed.code !== undefined && { code: diagnosed.code },
        ...diagnosed.severity !== undefined && { severity: diagnosed.severity === 'warning' ? WARNING : ERROR },
        ...diagnosed.unread && { tags: [UNNECESSARY] },
        message: editorMessage(diagnosed),
        range: diagnosed.span ? rangeOf(diagnosed.span) : zeroRange(),
      }]
    })

    this.host.client.notify('textDocument/publishDiagnostics', { uri: document.uri, version: document.version, diagnostics: [...compileErrors, ...typeErrors, ...this.host.problems.get(document.file) ?? []] })
  }
}

// Whether the component imports the file; a module named by an alias is taken for it when their names match.
export function importsFile(document: Document, file: string): boolean {
  const stem = (path: string) => basename(path).replace(EXTENSION, '')

  for (const [, specifier] of document.source.matchAll(IMPORT_SOURCE)) {
    if (specifier!.startsWith('.') ? [specifier!, `${specifier}.kay`].some(path => resolve(dirname(document.file), path) === file) : stem(specifier!) === stem(file))
      return true
  }

  return false
}

// A diagnostic as an editor shows it, its label, note and help on their own lines.
export function editorMessage({ message, label, note, help }: Pick<KayDiagnostic, 'message' | 'label' | 'note' | 'help'>): string {
  return [label !== undefined && label !== '' ? `${message} (${label})` : message, ...[['note', note], ['help', help]].flatMap(([kind, text]) => text === undefined ? [] : [`${kind}: ${text}`])].join('\n')
}

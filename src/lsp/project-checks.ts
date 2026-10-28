import type { CheckDiagnostic } from '../check'
import type { DiagnosticsQueue } from './diagnostics'
import type { LspHost, Project } from './host'
import type { Diagnostic, DocumentDiagnosticReport } from './protocol'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { configProblems, contentChecks, generatedChecks, generatedProblem, projectProblems } from '../check'
import { clientUri } from './bridge'
import { editorMessage } from './diagnostics'
import { ERROR, guard, WARNING } from './host'

// How long the project-wide checks wait after a save for the next, as saving every file at once makes.
const PROJECT_CHECKS_DELAY = 300

export class ProjectChecks {
  private timer?: Timer
  // The run of the project-wide checks in flight, and whether a save came during it.
  private projectChecks: Promise<void> | undefined
  private projectChecksStale = false
  // What the project-wide checks found, by file.
  problems = new Map<string, Diagnostic[]>()

  constructor(private readonly host: LspHost, private readonly queue: DiagnosticsQueue) {}

  // What `kay check` finds across the project, run after a save rather than on every keystroke, since it reads every collection, catalog and route.
  scheduleProjectChecks() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void guard(this.runProjectChecks()), PROJECT_CHECKS_DELAY)
  }

  private async runProjectChecks() {
    if (this.projectChecks) {
      this.projectChecksStale = true

      return
    }

    try {
      this.projectChecks = this.publishProblems()
      await this.projectChecks
    }
    finally {
      this.projectChecks = undefined

      // A save during a run, even a failed one, runs the checks again.
      if (this.projectChecksStale) {
        this.projectChecksStale = false
        this.scheduleProjectChecks()
      }
    }
  }

  // Each file whose problems changed, an open component's along with its own diagnostics, and none any longer for a file that had some.
  private async publishProblems() {
    const found = new Map<string, Diagnostic[]>()

    for (const problem of (await Promise.all([...this.host.projects.values()].map(async project => this.problemsOf(project)))).flat())
      found.set(problem.file, [...found.get(problem.file) ?? [], problemDiagnostic(problem)])

    const previous = this.problems

    this.problems = found

    let openChanged = false

    for (const file of new Set([...previous.keys(), ...found.keys()])) {
      if (Bun.deepEquals(previous.get(file), found.get(file)))
        continue

      if ([...this.host.documents.values()].some(open => open.file === file))
        openChanged = true
      else
        this.host.client.notify('textDocument/publishDiagnostics', { uri: clientUri(this.host, file), diagnostics: found.get(file) ?? [] })
    }

    // An open file goes through the one publish at a time, which reads the problems just stored.
    if (openChanged)
      await this.queue.publishAllDiagnostics()
  }

  private async problemsOf(project: Project): Promise<CheckDiagnostic[]> {
    const { root, options, types } = project

    if (!types)
      return []

    const content = await contentChecks(root, options, project.probes)
    const [problems, typeErrors] = await Promise.all([projectProblems(root, options, content, project.probes), this.generatedTypeErrors(root)])

    return [...configProblems(root, options, types), ...typeErrors.flatMap(diagnostic => generatedProblem(root, diagnostic, types, content) ?? []), ...problems]
  }

  // What tsgo finds in the modules kay writes for it to check what only types tell, each opened for the question.
  private async generatedTypeErrors(root: string): Promise<CheckDiagnostic[]> {
    const found = await Promise.all(generatedChecks(root).filter(file => existsSync(file)).map(async (file) => {
      const uri = pathToFileURL(file).href

      this.host.server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'typescript', version: 1, text: await Bun.file(file).text() } })

      try {
        const report = await this.host.server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument: { uri } })

        return (report.items ?? []).map((diagnostic): CheckDiagnostic => ({ file, line: diagnostic.range.start.line + 1, column: diagnostic.range.start.character + 1, code: typeof diagnostic.code === 'number' ? `TS${diagnostic.code}` : undefined, message: diagnostic.message }))
      }
      finally {
        this.host.server.notify('textDocument/didClose', { textDocument: { uri } })
      }
    }))

    return found.flat()
  }
}

// A problem of the project, at the start of the line and column it names.
export function problemDiagnostic(problem: CheckDiagnostic): Diagnostic {
  const position = { line: problem.line - 1, character: problem.column - 1 }

  return { range: { start: position, end: position }, severity: problem.severity === 'warning' ? WARNING : ERROR, source: 'kay', ...problem.code !== undefined && { code: problem.code }, message: editorMessage(problem) }
}

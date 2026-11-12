import type { ErrorCode, ErrorName } from './errors'
import type { Lint, LintLevel, LintName } from './lints'
import { ERRORS, explainError, isErrorCode } from './errors'
import { explainLint, isLint, LINTS } from './lints'

export type DiagnosticKind = 'lint' | 'error'

// What kay knows of one diagnostic, whether a lint (advice with a level an app sets) or an error (what stops a compile, a build or a request): the single answer to "what is this code".
export interface DiagnosticInfo {
  code: string
  kind: DiagnosticKind
  group: string
  summary: string
  // The level a lint has by default; an error has none, and no `// kay-allow` comment reaches it.
  level: LintLevel | undefined
  // Whether the registry knows a fix `kay check --fix` applies: an error says so, and a lint that replaces an old form always has one; any other lint may still offer one in the cases it can.
  quickFix: boolean
}

// The code of a lint or an error, which share one namespace: a test keeps them apart.
export type DiagnosticCode = LintName | ErrorName

export function isDiagnosticCode(name: string | undefined): name is DiagnosticCode {
  return isLint(name) || isErrorCode(name)
}

export function diagnosticInfo(code: string | undefined): DiagnosticInfo | undefined {
  if (isLint(code)) {
    const lint: Lint = LINTS[code]

    return { code, kind: 'lint', group: lint.group, summary: lint.summary, level: lint.level, quickFix: lint.since !== undefined }
  }

  if (isErrorCode(code)) {
    const error: ErrorCode = ERRORS[code]

    return { code, kind: 'error', group: error.group, summary: error.summary, level: undefined, quickFix: error.quickFix === true }
  }

  return undefined
}

// What `kay explain <code>` prints for a lint or an error.
export function explainDiagnostic(code: DiagnosticCode, where?: (file: string) => string): string {
  return isLint(code) ? explainLint(code) : explainError(code, where)
}

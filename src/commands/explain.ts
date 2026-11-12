import type { DiagnosticCode } from '../compiler/diagnostics'
import type { ErrorCode, ErrorGroup, ErrorName } from '../compiler/errors'
import type { Lint, LintGroup, LintName } from '../compiler/lints'
import type { Command } from './command'
import process from 'node:process'
import { diagnosticInfo, explainDiagnostic } from '../compiler/diagnostics'
import { ERROR_GROUPS, errorList, ERRORS, isErrorGroup } from '../compiler/errors'
import { isLintGroup, LINT_GROUPS, lintList, LINTS } from '../compiler/lints'
import { docFiles, searchDocs } from '../docs-search'
import { formatOption, printDocument, printFailure } from './command'
import { explainIsland } from './explain-island'
import { fixPath } from './fix-path'

// Lists the lints and the errors, or a group's, or explains the lint or error named; `island [file]` says whether a component is an island and why, or lists every island.
export const explain: Command = {
  usage: 'explain [lint|error|group|island [file]] [--format text|json]',
  options: { format: { type: 'string' } },
  positionals: 2,
  run: async ({ values, positionals: [name, file] }, refuse) => {
    const format = formatOption(refuse, values.format)

    if (format === undefined)
      return 2

    if (name === 'island')
      return explainIsland(file, format)

    if (file !== undefined) {
      printFailure('explain', `\`${name}\` takes no file: only \`island\` does`, format)

      return 1
    }

    if (name === undefined || isLintGroup(name) || isErrorGroup(name)) {
      if (format === 'json')
        printDocument(isErrorGroup(name) ? errorDocument(name) : lintDocument(name))
      else if (isErrorGroup(name))
        console.log(errorList(name))
      else
        console.log(isLintGroup(name) ? lintList(name) : `${lintList()}\n\n${errorList()}`)

      return 0
    }

    const info = diagnosticInfo(name)

    if (info === undefined) {
      printFailure('explain', `\`${name}\` is no lint, error or group; \`kay explain\` lists them${docsHint(name)}`, format)

      return 1
    }

    if (format === 'json')
      printDocument({ name, ...(info.kind === 'error' ? ERRORS[info.code as ErrorName] : LINTS[info.code as LintName]) })
    else
      console.log(explainDiagnostic(info.code as DiagnosticCode, fixPath))

    return 0
  },
}

// The groups, or the one named, and their lints with what each reports whole, then the errors.
function lintDocument(group: LintGroup | undefined) {
  const lints = Object.entries(LINTS as Record<string, Lint>).filter(([, lint]) => group === undefined || lint.group === group)

  return {
    groups: group === undefined ? LINT_GROUPS : { [group]: LINT_GROUPS[group] },
    lints: lints.map(([name, lint]) => ({ name, group: lint.group, level: lint.level, ...lint.since !== undefined && { since: lint.since }, summary: lint.summary })),
    ...group === undefined && errorDocument(undefined),
  }
}

// The error groups, or the one named, and their codes.
function errorDocument(group: ErrorGroup | undefined) {
  const errors = Object.entries(ERRORS as Record<string, ErrorCode>).filter(([, error]) => group === undefined || error.group === group)

  return {
    errorGroups: group === undefined ? ERROR_GROUPS : { [group]: ERROR_GROUPS[group] },
    errors: errors.map(([name, error]) => ({ name, group: error.group, summary: error.summary, fix: error.fix })),
  }
}

// Where `kay docs` documents a name that is no lint, as a component or a function taken for one.
// A docs file that cannot be read leaves the failure as it was.
function docsHint(name: string): string {
  try {
    const [best] = searchDocs(docFiles(process.cwd()), name)

    return best?.named !== true ? '' : `, and \`kay docs ${name}\` prints ${best.section.label}`
  }
  catch {
    return ''
  }
}

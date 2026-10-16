import type { ErrorCode, ErrorGroup } from '../compiler/errors'
import type { Lint, LintGroup } from '../compiler/lints'
import type { Command } from './command'
import { ERROR_GROUPS, errorList, ERRORS, explainError, isErrorCode, isErrorGroup } from '../compiler/errors'
import { explainLint, isLint, isLintGroup, LINT_GROUPS, lintList, LINTS } from '../compiler/lints'
import { formatOption, printDocument, printFailure } from './command'
import { USAGES } from './usages'

// Lists the lints and the errors, or a group's, or explains the lint or error named.
export const explain: Command = {
  usage: USAGES.explain,
  options: { format: { type: 'string' } },
  positionals: 1,
  run: ({ values, positionals: [name] }) => {
    const format = formatOption('explain', values.format)

    if (format === undefined)
      return 1

    if (name === undefined || isLintGroup(name) || isErrorGroup(name)) {
      if (format === 'json')
        printDocument(isErrorGroup(name) ? errorDocument(name) : lintDocument(name))
      else if (isErrorGroup(name))
        console.log(errorList(name))
      else
        console.log(isLintGroup(name) ? lintList(name) : `${lintList()}\n\n${errorList()}`)

      return 0
    }

    if (isErrorCode(name)) {
      if (format === 'json')
        printDocument({ name, ...ERRORS[name] as ErrorCode })
      else
        console.log(explainError(name))

      return 0
    }

    if (!isLint(name)) {
      printFailure('explain', `\`${name}\` is no lint, error or group; \`kay explain\` lists them`, format)

      return 1
    }

    if (format === 'json')
      printDocument({ name, ...LINTS[name] as Lint })
    else
      console.log(explainLint(name))

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

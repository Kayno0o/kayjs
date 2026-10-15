import type { Lint, LintGroup } from '../compiler/lints'
import type { Command } from './command'
import { explainLint, isLint, isLintGroup, LINT_GROUPS, lintList, LINTS } from '../compiler/lints'
import { formatOption, printDocument, printFailure } from './command'
import { USAGES } from './usages'

// Lists the lints, or a group's, or explains the lint named.
export const explain: Command = {
  usage: USAGES.explain,
  options: { format: { type: 'string' } },
  positionals: 1,
  run: ({ values, positionals: [name] }) => {
    const format = formatOption('explain', values.format)

    if (format === undefined)
      return 1

    if (name === undefined || isLintGroup(name)) {
      if (format === 'json')
        printDocument(lintDocument(name))
      else
        console.log(lintList(name))

      return 0
    }

    if (!isLint(name)) {
      printFailure('explain', `\`${name}\` is no lint or group; \`kay explain\` lists them`, format)

      return 1
    }

    if (format === 'json')
      printDocument({ name, ...LINTS[name] as Lint })
    else
      console.log(explainLint(name))

    return 0
  },
}

// The groups, or the one named, and their lints with what each reports whole.
function lintDocument(group: LintGroup | undefined) {
  const lints = Object.entries(LINTS as Record<string, Lint>).filter(([, lint]) => group === undefined || lint.group === group)

  return {
    groups: group === undefined ? LINT_GROUPS : { [group]: LINT_GROUPS[group] },
    lints: lints.map(([name, lint]) => ({ name, group: lint.group, level: lint.level, summary: lint.summary })),
  }
}

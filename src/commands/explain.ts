import type { Command } from './command'
import { explainLint, isLint, isLintGroup, lintList } from '../compiler/lints'

// Lists the lints, or a group's, or explains the lint named.
export const explain: Command = {
  usage: 'explain [lint|group]',
  options: {},
  positionals: 1,
  run: ({ positionals: [name] }) => {
    if (name === undefined || isLintGroup(name)) {
      console.log(lintList(name))

      return 0
    }

    if (!isLint(name)) {
      console.error(`kay explain: \`${name}\` is no lint or group; \`kay explain\` lists them`)

      return 1
    }

    console.log(explainLint(name))

    return 0
  },
}

import { builtinModules } from 'node:module'
import { configCheckOptions, writeShadowTypes } from '../src/check'
import { loadConfig } from '../src/config'

export interface LintResult { filePath: string, messages: { ruleId: string | null, line: number }[] }

// The same array as `builtinModules`, which node:module types as read-only.
const builtins: string[] = builtinModules as string[]
let running = 0
let hidden: string[] = []

// Bun lists its `bun:` modules among the builtins, which perfectionist would sort before `node:` imports as keslint under Node does not: they are hidden while a lint loads its rules.
async function withoutBunBuiltins<T>(run: () => Promise<T>): Promise<T> {
  if (running++ === 0) {
    hidden = builtins.filter(name => name.startsWith('bun:'))

    for (const name of hidden)
      builtins.splice(builtins.indexOf(name), 1)
  }

  try {
    return await run()
  }
  finally {
    if (--running === 0)
      builtins.push(...hidden)
  }
}

// Lints `path` of a scaffold in this process with the project's own config, after writing the types `kay lint` writes first: the same rules as the CLI, with ESLint, its plugins and the TypeScript services loaded once for every scaffold of the run instead of once per lint.
export async function lintInProcess(dir: string, path: string): Promise<LintResult[]> {
  await writeShadowTypes(dir, configCheckOptions(await loadConfig(dir)))

  const { ESLint } = await import('eslint')
  const results = await withoutBunBuiltins(async () => new ESLint({ cwd: dir }).lintFiles([path]))

  if (results.length === 0)
    throw new Error(`lintInProcess: ${path} of ${dir} matched no file`)

  return results.map(({ filePath, messages }) => ({ filePath, messages: messages.map(({ ruleId, line }) => ({ ruleId, line })) }))
}

import type { ProblemFormat } from './command'
import { existsSync } from 'node:fs'
import { printFailure } from './command'

// The text and the parsed content of the project's package.json; undefined after printing why there is none to upgrade.
export async function readManifest(manifest: string, root: string, format: ProblemFormat): Promise<{ original: string, packageJson: Record<string, unknown> } | undefined> {
  if (!existsSync(manifest)) {
    printFailure('upgrade', `${root} has no package.json`, format)

    return undefined
  }

  const original = await Bun.file(manifest).text()

  try {
    return { original, packageJson: JSON.parse(original) }
  }
  catch (error) {
    printFailure('upgrade', `package.json does not parse: ${error instanceof Error ? error.message : String(error)}`, format)

    return undefined
  }
}

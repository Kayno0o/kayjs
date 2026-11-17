import { rm } from 'node:fs/promises'
import { keepEager } from './lazy-components'
import { stubKeys } from './lazy-manifest'

// The last round builds whatever it finds.
const ROUNDS = 3

class Folded extends Error {}

// Marks the lazy components of the build that do not pay (see `stubKeys`) to load with the code drawing them, and ends the round, its files removed, when there were some: what the runtime chunk holds follows the imports the islands make, so the build is searched and run again.
export async function foldStubs(build: Bun.BuildOutput, nav: { build: Bun.BuildOutput } | undefined, last: boolean, keyOf: (entryPoint: string) => string | undefined): Promise<void> {
  if (last || !build.success || !keepEager(stubKeys(build.metafile!.outputs, keyOf)))
    return

  await Promise.all([build, nav?.build].flatMap(each => each?.outputs ?? []).map(async output => rm(output.path, { force: true })))

  throw new Folded()
}

// Runs a build, again when a round folded stubs; the run is told when it is the last.
export async function inRounds<T>(run: (last: boolean) => Promise<T>): Promise<T> {
  for (let round = 0; ; round++) {
    try {
      return await run(round === ROUNDS - 1)
    }
    catch (error) {
      if (!(error instanceof Folded))
        throw error
    }
  }
}

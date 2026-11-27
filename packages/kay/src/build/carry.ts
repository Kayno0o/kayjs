// The previous build's client files that a new build dropped, linked into its stage for one more deploy,
// so a page loaded before the deploy still finds the deferred island chunks it links (#3663).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { linkOrCopyFile } from './bundle'
import { isInside } from './is-inside'

/** Written at the root of each output: which client files the build made itself, and which it carried from the one before. */
export const ASSET_RECORD = '.kay-assets.json'

interface AssetRecord {
  /** The client folder, from the output root: `client`, or the asset prefix's folder in a static export. */
  dir: string
  assets: string[]
  carried: string[]
}

function readRecord(path: string): AssetRecord | undefined {
  if (!existsSync(path))
    return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AssetRecord>
    return typeof parsed.dir === 'string' && Array.isArray(parsed.assets) ? parsed as AssetRecord : undefined
  }
  catch {
    // A record kay cannot read carries nothing: the deploy still works, an old page reloads for its chunk as before.
    return undefined
  }
}

/**
 * Hard-links into `stageRoot/dir` each client file the build in `previousRoot` made and the stage lacks, with its `.br` and `.gz`, and writes this build's record.
 * What the previous build carried itself is left behind, so a file outlives one deploy, never two.
 */
export function carryPreviousAssets(previousRoot: string, stageRoot: string, dir: string, assets: readonly string[]): string[] {
  const previous = readRecord(join(previousRoot, ASSET_RECORD))
  const carried: string[] = []
  if (previous !== undefined) {
    const fromDir = join(previousRoot, previous.dir)
    const toDir = join(stageRoot, dir)
    for (const rel of previous.assets) {
      const from = join(fromDir, rel)
      const to = join(toDir, rel)
      if (!isInside(previousRoot, from) || !isInside(toDir, to) || !existsSync(from) || existsSync(to))
        continue
      for (const ext of ['', '.br', '.gz']) {
        if (existsSync(`${from}${ext}`))
          linkOrCopyFile(`${from}${ext}`, `${to}${ext}`)
      }
      carried.push(rel)
    }
  }
  const record: AssetRecord = { dir, assets: [...assets], carried }
  writeFileSync(join(stageRoot, ASSET_RECORD), JSON.stringify(record))
  return carried
}

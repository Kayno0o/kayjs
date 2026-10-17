import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { MANIFEST } from '../server/client'
import { filesUnder } from '../server/compress'

// How many earlier builds `kay build` keeps the chunks of, so a tab opened before a deploy finds the files it loads for a few deploys after.
export const KEPT_BUILDS = 3

// A script or stylesheet the bundler named after its content, or a file under `assets`, which is named after its content too, each with the compressed copies written beside it. What else the client folder holds changes in place: the search manifest, the notices, the image variants.
const CHUNK = /-[\da-z]{6,}\.(?:js|css)(?:\.br|\.gz)?$/i
const ASSET = /^assets[/\\]/
// The build just replaced, until the new one is good and it takes its place among the others, each a folder named after the time it was kept at.
const STAGING = 'next'
const BUILD_NAME = /^\d+$/

function keepable(file: string): boolean {
  return CHUNK.test(file) || ASSET.test(file)
}

// Where the files of the earlier builds wait: beside the output and not in it, as an executable embeds the output whole.
export function keptDir(output: string): string {
  return `${output}-kept`
}

async function filesOf(dir: string): Promise<string[]> {
  return (await filesUnder(dir)).map(file => relative(dir, file))
}

// Newest first.
async function buildsIn(kept: string): Promise<string[]> {
  if (!existsSync(kept))
    return []

  return (await readdir(kept)).filter(name => BUILD_NAME.test(name)).sort((a, b) => Number(b) - Number(a))
}

async function place(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })

  try {
    await link(from, to)
  }
  catch {
    // Another file system, or one without hard links.
    await copyFile(from, to)
  }
}

// Called before a build replaces the output: sets aside, as hard links, the files of the build in place that no earlier kept build holds.
// A run that did not finish leaves the output without its manifest, or with the last build waiting aside (`aside`): what was set aside then is still right, so it stays.
// One that failed after its manifest was written leaves a set-aside folder and an output nobody served: the files it holds join what was set aside.
export async function setAsideKept(output: string, aside: string): Promise<void> {
  if (existsSync(aside) || !existsSync(join(output, MANIFEST)))
    return

  const kept = keptDir(output)
  const staging = join(kept, STAGING)
  const dist = join(output, 'dist')
  const older = new Set((await Promise.all((await buildsIn(kept)).map(async name => filesOf(join(kept, name))))).flat())

  const waiting = new Set(await filesOf(staging))

  for (const file of await filesOf(dist)) {
    if (keepable(file) && !older.has(file) && !waiting.has(file))
      await place(join(dist, file), join(staging, file))
  }
}

// Called once a build is good: puts the files of the earlier builds back beside it, those it did not write itself, and the build set aside becomes the newest kept. The builds past `KEPT_BUILDS` go.
export async function restoreKept(output: string, now = Date.now()): Promise<void> {
  const kept = keptDir(output)

  if (!existsSync(kept))
    return

  const dist = join(output, 'dist')
  const staging = join(kept, STAGING)
  const builds = await buildsIn(kept)
  const alive: string[] = []

  // A file comes back once, and one the new build wrote is its own; the build set aside first, then the others from the newest.
  const bringBack = async (name: string): Promise<number> => {
    const dir = join(kept, name)
    let left = 0

    for (const file of await filesOf(dir)) {
      if (existsSync(join(dist, file))) {
        await rm(join(dir, file))
      }
      else {
        await place(join(dir, file), join(dist, file))
        left++
      }
    }

    return left
  }
  const holds = await bringBack(STAGING) > 0
  const room = holds ? KEPT_BUILDS - 1 : KEPT_BUILDS

  for (const name of builds) {
    if (alive.length < room && await bringBack(name) > 0)
      alive.push(name)
  }

  if (holds) {
    // A build kept within the same millisecond as the one before it would take its place.
    await rename(staging, join(kept, String(Math.max(now, Number(alive[0] ?? 0) + 1))))
  }
  else {
    await rm(staging, { recursive: true, force: true })
  }

  await Promise.all(builds.filter(name => !alive.includes(name)).map(async name => rm(join(kept, name), { recursive: true, force: true })))
}

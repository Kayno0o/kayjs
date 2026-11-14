import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { diffPngs } from '../dev/screenshot-diff'

export interface MatchScreenshotOptions {
  // How many pixels may differ from the baseline, none by default; a channel within a few levels counts as the same pixel, so anti-aliasing noise is not a difference.
  maxDiffPixels?: number | undefined
}

const NAME = /^[\w.-]+(?:\/[\w.-]+)*$/
const TEST_FILE = /(\/[^\s():]+\.test\.[cm]?[jt]sx?):\d+:\d+/

// The test file calling `matchScreenshot`, read off the stack where the call began, as Bun gives no hook the file of the running test.
export function callingTestFile(stack: string | undefined): string {
  const found = TEST_FILE.exec(stack ?? '')?.[1]

  if (found === undefined)
    throw new Error('kay: matchScreenshot found no `*.test.ts` file among its callers to keep the baseline beside')

  return found
}

// What the page's `matchScreenshot` runs: the test file is read off `stack`, taken where the call began, while it is still on the stack, before the call queues in `serial`.
export async function matchView(stack: string | undefined, name: string, options: MatchScreenshotOptions | undefined, serial: <T>(run: () => Promise<T>) => Promise<T>, fontsReady: () => Promise<unknown>, shoot: () => Promise<Uint8Array>): Promise<void> {
  const testFile = callingTestFile(stack)

  await serial(async () => {
    await fontsReady()
    await matchScreenshot(new Uint8Array(await shoot()), name, testFile, options)
  })
}

// Compares a screenshot with the baseline `<test dir>/__screenshots__/<test file>/<name>.png`.
// The baseline is written when there is none, or when `KAY_UPDATE_SCREENSHOTS` is set, and a missing one fails under `CI`; a difference writes `<name>.actual.png` and `<name>.diff.png` beside it and fails, and a match removes them.
export async function matchScreenshot(png: Uint8Array, name: string, testFile: string, options: MatchScreenshotOptions = {}): Promise<void> {
  if (!NAME.test(name) || name.split('/').includes('..'))
    throw new Error(`kay: matchScreenshot takes a name of letters, digits, dots, dashes and slashes, not ${JSON.stringify(name)}`)

  const base = join(dirname(testFile), '__screenshots__', basename(testFile), name)
  const baseline = `${base}.png`
  const update = (process.env.KAY_UPDATE_SCREENSHOTS ?? '') !== '' && process.env.KAY_UPDATE_SCREENSHOTS !== '0'

  rmSync(`${base}.actual.png`, { force: true })
  rmSync(`${base}.diff.png`, { force: true })

  if (update || !existsSync(baseline)) {
    if (!update && (process.env.CI ?? '') !== '')
      throw new Error(`kay: matchScreenshot has no baseline ${baseline} and a CI run writes none: run the test locally and commit it`)

    mkdirSync(dirname(baseline), { recursive: true })
    await Bun.write(baseline, png)

    return
  }

  const diff = await diffPngs(new Uint8Array(await Bun.file(baseline).arrayBuffer()), png)
  const allowed = options.maxDiffPixels ?? 0

  if (diff.changed <= allowed)
    return

  await Bun.write(`${base}.actual.png`, png)
  await Bun.write(`${base}.diff.png`, diff.image)

  const { box } = diff

  throw new Error(`kay: the screenshot ${name} differs from ${baseline} in ${diff.changed} pixels (${(diff.ratio * 100).toFixed(2)}%)${box === undefined ? '' : `, within ${box.width}x${box.height} at ${box.x},${box.y}`}${allowed === 0 ? '' : `, over the ${allowed} allowed`}; see ${base}.diff.png, and rewrite the baseline with KAY_UPDATE_SCREENSHOTS=1 if the change is meant`)
}

import type { ExtensionProblem } from '../config'
import { resolve } from 'node:path'
import process from 'node:process'
import { FILES_MARKER, loadedFiles } from '../check/loaded'
import { loadConfig } from '../config'
import { buildingWithoutEnv } from '../server/env-state'
import { setImageColors } from '../server/image-color'
import { EXTENSIONS_MARKER, FEEDS_MARKER, PROBLEMS_MARKER, USES_MARKER } from './claims'
import { setMarkdownDefaults } from './load'
import { contentProblems } from './server'

// Run by `kay check` in a process of its own, so the project's `.kay` loader never meets the checking process's: prints the content problems as JSON on a marked line, whatever else the content config logs.
const [root, config, site] = process.argv.slice(2)

// The checking machine lacks the server's environment, as `kay build` does.
buildingWithoutEnv()

const loaded = await loadConfig(root!)

setMarkdownDefaults(loaded.markdown)
setImageColors(loaded.images?.placeholder !== false)

const { problems, uses, feeds, read } = await contentProblems(root!, config === undefined || config === '' ? undefined : config, site === 'site')

console.log(`${PROBLEMS_MARKER}${JSON.stringify(problems)}`)
// The collections are registered now, which is what an extension's check reads them from. One that throws is reported as a problem of its own, not as a crash of the check.
const extensionProblems: ExtensionProblem[] = []

for (const extension of loaded.extensions ?? []) {
  try {
    extensionProblems.push(...await extension.check?.() ?? [])
  }
  catch (error) {
    extensionProblems.push({ message: `${extension.name}'s check failed: ${error instanceof Error ? error.message : String(error)}`, severity: 'error' })
  }
}

console.log(`${EXTENSIONS_MARKER}${JSON.stringify(extensionProblems)}`)
console.log(`${USES_MARKER}${JSON.stringify(uses)}`)
console.log(`${FEEDS_MARKER}${JSON.stringify(feeds)}`)
console.log(`${FILES_MARKER}${JSON.stringify(loadedFiles(resolve(root!), read))}`)
// A timer or a connection the content config left open would keep the check waiting.
process.exit(0)

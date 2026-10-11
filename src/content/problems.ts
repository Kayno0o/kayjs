import process from 'node:process'
import { buildingWithoutEnv } from '../server/env'
import { contentProblems, FEEDS_MARKER, PROBLEMS_MARKER, USES_MARKER } from './server'

// Run by `kay check` in a process of its own, so the project's `.kay` loader never meets the checking process's: prints the content problems as JSON on a marked line, whatever else the content config logs.
const [root, config, site] = process.argv.slice(2)

// The checking machine lacks the server's environment, as `kay build` does.
buildingWithoutEnv()

const { problems, uses, feeds } = await contentProblems(root!, config === undefined || config === '' ? undefined : config, site === 'site')

console.log(`${PROBLEMS_MARKER}${JSON.stringify(problems)}`)
console.log(`${USES_MARKER}${JSON.stringify(uses)}`)
console.log(`${FEEDS_MARKER}${JSON.stringify(feeds)}`)

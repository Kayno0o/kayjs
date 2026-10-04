import process from 'node:process'
import { contentProblems, PROBLEMS_MARKER } from './server'

// Run by `kay check` in a process of its own, so the project's `.kay` loader never meets the checking process's: prints the content problems as JSON on a marked line, whatever else the content config logs.
const [root, config] = process.argv.slice(2)

console.log(`${PROBLEMS_MARKER}${JSON.stringify(await contentProblems(root!, config || undefined))}`)

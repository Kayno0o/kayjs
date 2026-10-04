import process from 'node:process'
import { contentProblems } from './server'

// Run by `kay check` in a process of its own, so the project's `.kay` loader never meets the checking process's: prints the content problems as JSON.
const [root, config] = process.argv.slice(2)

console.log(JSON.stringify(await contentProblems(root!, config || undefined)))

import { join } from 'node:path'
import process from 'node:process'

// Preloaded before `kay/test/preload`, which registers the loader for the project this names, so a component imported in a test finds the fixture app's icons. Components mount from the fixture app.
process.env.KAY_ROOT = join(import.meta.dir, '..', 'tests', 'fixture')

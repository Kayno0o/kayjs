import { join } from 'node:path'
import process from 'node:process'

// Preloaded after `kay/test/dom`. Components mount from the fixture app.
process.env.KAY_ROOT = join(import.meta.dir, '..', 'tests', 'fixture')

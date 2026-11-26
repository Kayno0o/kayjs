import type { TaskDefinition, TaskSpec, TaskVerifier } from '../lib/types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verify as verify01 } from './01-static-blog-i18n/verify'
import { verify as verify02 } from './02-filter-island/verify'
import { verify as verify03 } from './03-action-form/verify'
import { verify as verify04 } from './04-auth-crud-sqlite/verify'
import { verify as verify05 } from './05-streaming-regions/verify'
import { verify as verify06 } from './06-mcp-tools/verify'

const TASKS_DIR = import.meta.dir

const VERIFIERS: ReadonlyArray<{ id: string, verify: TaskVerifier }> = [
  { id: '01-static-blog-i18n', verify: verify01 },
  { id: '02-filter-island', verify: verify02 },
  { id: '03-action-form', verify: verify03 },
  { id: '04-auth-crud-sqlite', verify: verify04 },
  { id: '05-streaming-regions', verify: verify05 },
  { id: '06-mcp-tools', verify: verify06 },
]

function loadTaskEntry(id: string, verify: TaskVerifier): TaskDefinition {
  const dir = join(TASKS_DIR, id)
  const spec = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8')) as TaskSpec
  if (spec.id !== id)
    throw new Error(`evals: task.json id "${spec.id}" does not match folder "${id}"`)
  const promptPath = join(dir, 'prompt.md')
  const prompt = readFileSync(promptPath, 'utf8')
  return { spec, promptPath, prompt, verify }
}

let cachedTasks: readonly TaskDefinition[] | undefined

export function listTasks(): readonly TaskDefinition[] {
  if (cachedTasks === undefined)
    cachedTasks = VERIFIERS.map(entry => loadTaskEntry(entry.id, entry.verify))
  return cachedTasks
}

export function getTask(id: string): TaskDefinition {
  const found = listTasks().find(t => t.spec.id === id)
  if (found === undefined) {
    const known = listTasks().map(t => t.spec.id).join(', ')
    throw new Error(`evals: unknown task "${id}". Available tasks: ${known}`)
  }
  return found
}

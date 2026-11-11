import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { workflowStartId } from '../src/check/workflow-start-id'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('workflow-start-id-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-workflow-start-id', () => {
  it('renames id in the options of start() on a workflow declared anywhere in the project, a shorthand included', async () => {
    const flows = 'import { workflow } from \'kay/server\'\n\nexport const onboarding = workflow(\'onboarding\', async () => undefined)\n'
    const actions = 'import { onboarding } from \'./flows\'\n\nconst id = \'u1\'\n\nawait onboarding.start({ userId: 1 }, { id: \'u1\', delay: \'1s\' })\nawait onboarding.start(undefined, { id })\nawait onboarding.start(undefined, { key: \'u2\' })\n'
    const page = '---\nimport { onboarding } from \'../flows\'\n\nawait onboarding.start(undefined, { id: \'p\' })\n---\np hi\n'
    const root = await project({ 'src/flows.ts': flows, 'src/actions.ts': actions, 'src/routes/page.kay': page })

    try {
      const found = await workflowStartId(root, {})

      expect(found).toHaveLength(3)
      expect(found.every(one => one.code === 'deprecated-workflow-start-id' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/actions.ts')).text()).toBe(actions.replace('{ id: \'u1\'', '{ key: \'u1\'').replace('{ id })', '{ key: id })'))
      expect(await Bun.file(join(root, 'src/routes/page.kay')).text()).toBe(page.replace('{ id:', '{ key:'))
      expect(await workflowStartId(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports an id beside a key with no fix, and leaves other start calls alone', async () => {
    const script = 'import { workflow } from \'kay/server\'\nimport { other } from \'./mine\'\n\nconst flow = workflow(\'f\', async () => undefined)\n\nawait flow.start(undefined, { id: \'a\', key: \'a\' })\nawait other.start(undefined, { id: \'a\' })\nawait flow.start(undefined, { delay: \'1s\' })\n'
    const root = await project({ 'src/jobs.ts': script })

    try {
      const found = await workflowStartId(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]!.fixes).toBeUndefined()
      expect(await workflowStartId(root, { lints: { 'deprecated-workflow-start-id': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

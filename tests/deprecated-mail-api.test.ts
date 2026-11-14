import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { mailApi } from '../src/check/mail-api'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('mail-api-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

const FORM = '---\nimport SubscribeForm from \'@kayjs/mail/subscribe-form.kay\'\nimport { subscribe } from \'./actions\'\n---\nSubscribeForm(action={subscribe})\n'

describe('deprecated-mail-form', () => {
  it('writes kayjs-ui\'s path with a safe fix when the project lists kayjs-ui', async () => {
    const root = await project({ 'package.json': '{"dependencies":{"@kayjs/ui":"~1.105.0"}}', 'src/pages/index.kay': FORM })

    try {
      const found = await mailApi(root, {})

      expect(found.map(diagnostic => diagnostic.code)).toEqual(['deprecated-mail-form'])
      expect(found[0]?.fixes?.[0]?.safe).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/pages/index.kay')).text()).toBe(FORM.replace('@kayjs/mail/', '@kayjs/ui/'))
      expect(await mailApi(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('offers the fix without trusting it when the project has no kayjs-ui', async () => {
    const root = await project({ 'package.json': '{"dependencies":{"@kayjs/mail":"~1.105.0"}}', 'src/pages/index.kay': FORM })

    try {
      const found = await mailApi(root, {})

      expect(found[0]?.fixes?.[0]?.safe).toBe(false)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/pages/index.kay')).text()).toBe(FORM)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is silenced by the lint level', async () => {
    const root = await project({ 'src/pages/index.kay': FORM })

    try {
      expect(await mailApi(root, { lints: { 'deprecated-mail-form': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deprecated-mail-send', () => {
  it('reports send, enqueue and registeredMailer imported from kayjs-mail, with no fix', async () => {
    const root = await project({ 'src/jobs.ts': 'import { enqueue, mailer, registeredMailer, send as deliver } from \'@kayjs/mail\'\n\nexport const all = [enqueue, mailer, registeredMailer, deliver]\n' })

    try {
      const found = await mailApi(root, {})

      expect(found.map(diagnostic => diagnostic.code)).toEqual(['deprecated-mail-send', 'deprecated-mail-send', 'deprecated-mail-send'])
      expect(found.map(diagnostic => (/`(\w+)\(\)`/).exec(diagnostic.message)?.[1])).toEqual(['enqueue', 'registeredMailer', 'send'])
      expect(found.every(diagnostic => diagnostic.fixes === undefined)).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a type import and the other names alone', async () => {
    const root = await project({ 'src/a.ts': 'import type { send } from \'@kayjs/mail\'\nimport { outbox, mailer } from \'@kayjs/mail\'\nimport { send as other } from \'./other\'\n\nexport const all = [outbox, mailer, other]\n' })

    try {
      expect(await mailApi(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

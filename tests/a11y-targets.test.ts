import { expect, it } from 'bun:test'
import { pagesToAudit } from '../src/a11y/targets'
import { loadConfig } from '../src/config-loader'
import { fixtureCopy } from './scratch'

it('lists a folder collection from the project, whatever the working directory', async () => {
  const root = await fixtureCopy('content')
  const { targets, skipped } = await pagesToAudit(root, await loadConfig(root))

  expect(skipped.filter(each => each.why.includes('cannot be listed'))).toEqual([])
  expect(targets.some(target => target.route === '/blog/:slug')).toBe(true)
})

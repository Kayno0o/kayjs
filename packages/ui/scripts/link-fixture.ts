import { existsSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'

// The fixture app installs this library as an app installs it, under its node_modules, linked back to the repository root.
const link = join(import.meta.dir, '..', 'tests', 'fixture', 'node_modules', '@kaynooo', 'kayjs-ui')

if (!existsSync(link)) {
  await mkdir(join(link, '..'), { recursive: true })
  await symlink(join('..', '..', '..', '..'), link)
}

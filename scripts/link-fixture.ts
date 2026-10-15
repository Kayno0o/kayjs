import { existsSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

// Run as a library's `prepare`, from its folder: its fixture app installs the library as an app installs it, under its node_modules, linked back to the library's folder.
const library = process.cwd()
const { name } = await Bun.file(join(library, 'package.json')).json() as { name: string }
const link = join(library, 'tests', 'fixture', 'node_modules', name)

if (!existsSync(link)) {
  await mkdir(dirname(link), { recursive: true })
  await symlink(relative(dirname(link), library), link)
}

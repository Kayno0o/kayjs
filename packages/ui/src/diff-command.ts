// `kay ui diff [component]`: what kayjs-ui changed in an ejected component since the version it was copied from.
import type { KayCommand } from 'kay/library'
import type { Manifest } from './eject'
import { existsSync } from 'node:fs'
import { componentFile, EJECTED_DIR, libraryFile, libraryVersion, MANIFEST, readManifest, unifiedDiff, UPSTREAM_DIR, upstreamBase, upstreamPath, writeAll } from './eject'

// Records the installed text as the one the copy now follows, once its changes are merged.
async function accept(root: string, file: string, manifest: Manifest, installed: string): Promise<number> {
  const entry = manifest[file]!
  const writes = new Map<string, string>()

  for (const path of entry.files) {
    if (!existsSync(libraryFile(path))) {
      console.error(`kay ui diff: ${path} is gone from kayjs-ui ${installed}, so there is nothing to accept`)

      return 1
    }

    writes.set(upstreamPath(root, `${path}.base`), await Bun.file(libraryFile(path)).text())
  }

  entry.version = installed
  writes.set(upstreamPath(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeAll(writes)
  console.log(`${file}: follows kayjs-ui ${installed} from now on`)

  return 0
}

const command: KayCommand = {
  usage: 'ui diff [component] [--check | --accept]',
  options: { check: { type: 'boolean' }, accept: { type: 'boolean' } },
  positionals: 1,
  run: async ({ values, positionals: [name] }, refuse, { root }) => {
    if (values.accept === true && (values.check === true || name === undefined))
      return refuse('--accept takes one component and no --check')

    const manifest = await readManifest(root)
    const only = name === undefined ? undefined : componentFile(name)

    if (name !== undefined && (only === undefined || manifest[only] === undefined)) {
      console.error(`kay ui diff: ${name} is not ejected`)

      return 1
    }

    const names = Object.keys(manifest).filter(file => only === undefined || file === only).toSorted()

    if (names.length === 0) {
      console.log('nothing ejected: `kay ui eject <component>` copies one')

      return 0
    }

    const installed = await libraryVersion()

    if (values.accept === true)
      return accept(root, only!, manifest, installed)

    let changed = 0

    for (const file of names) {
      const { version, files } = manifest[file]!
      const diffs: string[] = []
      const merges: string[] = []

      for (const path of files) {
        const now = existsSync(libraryFile(path)) ? await Bun.file(libraryFile(path)).text() : undefined
        const diff = now === undefined ? `${path} is gone from kayjs-ui ${installed}` : unifiedDiff(await upstreamBase(root, path), now, path)

        if (diff !== '') {
          diffs.push(diff)

          if (now !== undefined)
            merges.push(`  git merge-file src/${EJECTED_DIR}/${path} src/${EJECTED_DIR}/${UPSTREAM_DIR}/${path}.base ${libraryFile(path)}`)
        }
      }

      if (diffs.length === 0) {
        console.log(`${file}: up to date with kayjs-ui ${installed} (copied from ${version})`)

        continue
      }

      changed++
      console.log(`${file}: kayjs-ui changed it between ${version} and ${installed}\n\n${diffs.join('\n\n')}\n\nMerge into the copy by hand, or per file with git:\n${merges.join('\n')}`)
    }

    return values.check === true && changed > 0 ? 1 : 0
  },
}

export default command

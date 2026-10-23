// `kay ui diff [component]`: what kayjs-ui changed in an ejected component since the version it was copied from.
import type { KayCommand } from 'kay/library'
import type { Manifest } from './eject'
import { existsSync } from 'node:fs'
import { componentFile, EJECTED_DIR, guarded, hashOf, libraryFile, libraryVersion, MANIFEST, readManifest, unifiedDiff, UPSTREAM_DIR, upstreamBase, upstreamPath, writeAll } from './eject'

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

  for (const path of Object.keys(entry.helpers ?? {})) {
    if (existsSync(libraryFile(path)))
      entry.helpers![path] = hashOf(await Bun.file(libraryFile(path)).text())
    else
      delete entry.helpers![path]
  }

  entry.version = installed
  writes.set(upstreamPath(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeAll(writes)
  console.log(`${file}: follows kayjs-ui ${installed} from now on`)

  return 0
}

// What the library changed in the helpers a copy imports from it, which the copy cannot show: it only knows their hash from when it was copied.
async function helperChanges(manifest: Manifest, file: string): Promise<string[]> {
  const copied = new Set(Object.values(manifest).flatMap(entry => entry?.files ?? []))
  const lines: string[] = []

  for (const [path, hash] of Object.entries(manifest[file]!.helpers ?? {}).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (copied.has(path))
      continue

    if (!existsSync(libraryFile(path)))
      lines.push(`  ${path} is gone from kayjs-ui, so the copy's import of it no longer resolves`)
    else if (hashOf(await Bun.file(libraryFile(path)).text()) !== hash)
      lines.push(`  ${path} changed in kayjs-ui, and the copy imports it: read ${libraryFile(path)}`)
  }

  return lines
}

const command: KayCommand = {
  usage: 'ui diff [component] [--check | --accept]',
  options: { check: { type: 'boolean' }, accept: { type: 'boolean' } },
  positionals: 1,
  run: async ({ values, positionals: [name] }, refuse, { root }) => guarded('diff', async () => {
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

      const helpers = await helperChanges(manifest, file)

      if (diffs.length === 0 && helpers.length === 0) {
        console.log(`${file}: up to date with kayjs-ui ${installed} (copied from ${version})`)

        continue
      }

      changed++
      const merge = diffs.length === 0 ? '' : `\n\n${diffs.join('\n\n')}\n\nMerge into the copy by hand, or per file with git (the copy's imports of the library were rewritten, so check them after):\n${merges.join('\n')}`
      const helped = helpers.length === 0 ? '' : `\n\nHelpers the copy imports from kayjs-ui:\n${helpers.join('\n')}`

      console.log(`${file}: kayjs-ui changed it between ${version} and ${installed}${merge}${helped}`)
    }

    return values.check === true && changed > 0 ? 1 : 0
  }),
}

export default command

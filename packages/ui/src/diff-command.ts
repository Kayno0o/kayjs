// `kay ui diff [component]`: what kayjs-ui changed in an ejected component since the version it was copied from.
import type { CommandProject, KayCommand } from 'kay/library'
import type { Manifest } from './eject'
import { existsSync } from 'node:fs'
import { componentFile, EJECTED_DIR, guarded, hashOf, libraryFile, libraryVersion, MANIFEST, readManifest, unifiedDiff, UPSTREAM_DIR, upstreamBase, upstreamPath, writeAll } from './eject'

// Records the installed text as the one the copy now follows, once its changes are merged.
async function accept(project: CommandProject, file: string, manifest: Manifest, installed: string): Promise<number> {
  const { root, fail, format, quiet, result } = project
  const entry = manifest[file]!
  const writes = new Map<string, string>()

  for (const path of entry.files) {
    if (!existsSync(libraryFile(path))) {
      return fail(`${path} is gone from kayjs-ui ${installed}, so there is nothing to accept`)
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
  result({ installed, components: [{ file, version: installed, upToDate: true }], changed: 0, accepted: file })

  if (!quiet && format === 'text')
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
  refuses: { 'dry-run': 'writes only with --accept, which records the version the copy follows' },
  positionals: 1,
  run: async ({ values, positionals: [name] }, refuse, project) => guarded(project.fail, async () => {
    const { root, fail, format, quiet, result } = project

    if (values.accept === true && (values.check === true || name === undefined))
      return refuse('--accept takes one component and no --check')

    const manifest = await readManifest(root)
    const only = name === undefined ? undefined : componentFile(name)

    if (name !== undefined && (only === undefined || manifest[only] === undefined))
      return fail(`${name} is not ejected`)

    const names = Object.keys(manifest).filter(file => only === undefined || file === only).toSorted()

    if (names.length === 0) {
      result({ installed: await libraryVersion(), components: [], changed: 0 })

      if (!quiet && format === 'text')
        console.log('nothing ejected: `kay ui eject <component>` copies one')

      return 0
    }

    const installed = await libraryVersion()

    if (values.accept === true)
      return accept(project, only!, manifest, installed)

    let changed = 0
    const components: { file: string, version: string, upToDate: boolean }[] = []
    // What a person reads, printed once the answer is known to be wanted as text: an up-to-date copy is not worth a line under --quiet.
    const printed = (line: string, upToDate: boolean) => {
      if (format === 'text' && !(quiet && upToDate))
        console.log(line)
    }

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
        components.push({ file, version, upToDate: true })
        printed(`${file}: up to date with kayjs-ui ${installed} (copied from ${version})`, true)

        continue
      }

      changed++
      const merge = diffs.length === 0 ? '' : `\n\n${diffs.join('\n\n')}\n\nMerge into the copy by hand, or per file with git (the copy's imports of the library were rewritten, so check them after):\n${merges.join('\n')}`
      const helped = helpers.length === 0 ? '' : `\n\nHelpers the copy imports from kayjs-ui (once the copy works with them, \`kay ui diff ${file.replace('.kay', '')} --accept\` records them):\n${helpers.join('\n')}`

      components.push({ file, version, upToDate: false })
      printed(`${file}: kayjs-ui changed it between ${version} and ${installed}${merge}${helped}`, false)
    }

    result({ installed, components, changed })

    return values.check === true && changed > 0 ? 1 : 0
  }),
}

export default command

// `kay ui eject <component>`: copies one component of kayjs-ui into the app, for what a recipe in `src/ui.ts` cannot express.
import type { KayCommand } from 'kay/library'
import { relative } from 'node:path'
import { changesFor, componentFile, EJECTED_DIR, guarded, plan, readManifest, writeAll } from './eject'

const command: KayCommand = {
  usage: 'ui eject <component>',
  options: {},
  positionals: 1,
  run: async ({ positionals: [name] }, refuse, { root, fail, format, dryRun, quiet, result }) => guarded(fail, async () => {
    if (name === undefined)
      return refuse('ui eject needs the component to copy, such as `kay ui eject card`')

    const file = componentFile(name)

    if (file === undefined)
      return fail(`kayjs-ui has no component ${name}`)

    if ((await readManifest(root))[file] !== undefined)
      return fail(`${file} is ejected already; \`kay ui diff ${name}\` shows what kayjs-ui changed since`)

    const ejection = await plan(file)
    const changes = await changesFor(root, ejection)

    if ('exists' in changes)
      return fail(`${changes.exists.map(path => relative(root, path)).join(', ')} exists already, so nothing was copied`)

    if (!dryRun)
      await writeAll(changes.writes)

    result({ component: name, files: ejection.files, rewritten: changes.rewritten, notes: changes.notes, stillOnLibrary: ejection.users, dryRun })

    if (quiet || format === 'json')
      return 0

    console.log(`${dryRun ? 'would copy' : 'copied'} ${ejection.files.join(', ')} to src/${EJECTED_DIR}`)

    for (const path of changes.rewritten)
      console.log(`  ${dryRun ? 'would rewrite' : 'rewrote'} the imports of ${path}`)

    for (const note of changes.notes)
      console.log(`  ${note}`)

    if (ejection.users.length > 0)
      console.log(`  still on kayjs-ui's ${ejection.file}: ${ejection.users.join(', ')}`)

    return 0
  }),
}

export default command

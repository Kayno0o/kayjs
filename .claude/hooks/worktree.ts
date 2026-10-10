import { dirname, join } from 'node:path'
import process from 'node:process'
import { $ } from 'bun'

// Claude Code's WorktreeCreate and WorktreeRemove hooks, and `just worktree <name>`: a worktree starts at the HEAD it is made from and installs its own dependencies, so its `node_modules/kay -> ..` runs its own source rather than the main checkout's.
// `bun .claude/hooks/worktree.ts create [name]` or `remove`, reading the hook's input on stdin when no name is given; only the worktree path goes to stdout, which Claude Code reads.
const PACKAGES = ['.', 'bench/apps/solid', 'bench/apps/svelte']

async function mainCheckout(dir: string): Promise<string> {
  return dirname((await $`git rev-parse --path-format=absolute --git-common-dir`.cwd(dir).quiet().text()).trim())
}

async function create(from: string, name: string): Promise<string> {
  const path = join(await mainCheckout(from), '.claude/worktrees', name)

  await $`git worktree add -b ${`worktree-${name}`} ${path} HEAD`.cwd(from).quiet()

  for (const dir of PACKAGES)
    await $`bun install --frozen-lockfile`.cwd(join(path, dir)).quiet()

  return path
}

// The branch goes too once merged; `git branch -d` keeps one holding commits nothing else has.
async function remove(path: string) {
  const root = await mainCheckout(path)
  const branch = (await $`git branch --show-current`.cwd(path).quiet().text()).trim()

  await $`git worktree remove --force ${path}`.cwd(root).quiet()

  if (branch !== '')
    await $`git branch -d ${branch}`.cwd(root).quiet().nothrow()
}

const [command, name] = process.argv.slice(2)
const input = name === undefined ? await Bun.stdin.json() as { cwd: string, name: string, worktree_path: string } : undefined

if (command === 'create')
  console.log(await create(input?.cwd ?? process.cwd(), input?.name ?? name!))
else if (command === 'remove' && input !== undefined)
  await remove(input.worktree_path)
else
  throw new Error('usage: bun .claude/hooks/worktree.ts create [name] | remove (hook input on stdin)')

import { cp, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { ZED_MANIFEST, zedReleasable, zedRelease } from '../scripts/zed-release'
import { scratchDir } from './scratch'

// Decisions:
// - The tests skip without the tree-sitter CLI (and nvim for the editor one) instead of failing, so a CI image without them stays green: they run wherever the tools are installed, which is where the grammar is edited.
// - Every .kay file of tests/fixtures and examples/ must parse without an ERROR or MISSING node, as `tree-sitter parse` exits 0 for a file with errors, so its output is read.
const ROOT = join(import.meta.dir, '..')
const GRAMMAR = join(ROOT, 'editors/tree-sitter-kay')
const treeSitter = Bun.which('tree-sitter')
const nvim = Bun.which('nvim')
const TREE_ERROR = /\((?:ERROR|MISSING)\b/

// Bun runs the grammar's JavaScript, and the compiled parser stays in a directory of the test's own.
async function run(command: string[], options: { cwd?: string, libdir?: string } = {}): Promise<{ output: string, code: number }> {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? GRAMMAR,
    env: { ...Bun.env, TREE_SITTER_JS_RUNTIME: 'bun', ...(options.libdir !== undefined ? { TREE_SITTER_LIBDIR: options.libdir } : {}) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { output: stdout + stderr, code }
}

async function kayFiles(): Promise<string[]> {
  const files: string[] = []

  for (const folder of ['tests/fixtures', 'examples']) {
    for await (const file of new Bun.Glob('**/*.kay').scan({ cwd: join(ROOT, folder), absolute: true })) {
      if (!file.includes('/node_modules/') && !file.includes('/.kay/'))
        files.push(file)
    }
  }

  return files.toSorted()
}

// Runs wherever the tests do: the release rewrites this file.
describe('the Zed extension release', () => {
  it('rewrites the extension version and grammar tag for a release, on a copy', async () => {
    const dir = await scratchDir('zed-release-')
    const copy = join(dir, 'extension.toml')

    await cp(join(ROOT, ZED_MANIFEST), copy)
    const manifest = await Bun.file(copy).text()
    const released = zedRelease(manifest, '1.72.0')

    expect(zedReleasable(manifest)).toBe(true)
    expect(zedReleasable('id = "kay"')).toBe(false)
    expect(released).toContain('version = "1.72.0"')
    expect(released).toContain('rev = "v1.72.0"')
    expect(released).toContain('path = "editors/tree-sitter-kay"')
    expect(await Bun.file(join(ROOT, ZED_MANIFEST)).text()).not.toContain('1.72.0')
  })

  it('leaves a version or rev key outside its table alone', async () => {
    const dir = await scratchDir('zed-release-')
    const copy = join(dir, 'extension.toml')

    await Bun.write(copy, ['id = "kay"', 'version = "0.1.0"', '', '[language_servers.kay]', 'version = "9.9.9"', 'rev = "keep"', '', '[grammars.kay]', 'version = "8.8.8"', 'rev = "unreleased"', 'rev = "second"', '', '[other]', 'rev = "other"', ''].join('\n'))
    const manifest = await Bun.file(copy).text()
    const released = zedRelease(manifest, '1.72.0')

    expect(released).toBe(manifest.replace('version = "0.1.0"', 'version = "1.72.0"').replace('rev = "unreleased"', 'rev = "v1.72.0"'))
    expect(zedReleasable('[grammars.kay]\nrev = "x"')).toBe(false)
    expect(zedReleasable('version = "1.0.0"\n[language_servers.kay]\nrev = "x"')).toBe(false)
  })
})

describe.skipIf(treeSitter === null)('tree-sitter grammar', () => {
  it('parses every .kay file of the fixtures and the examples without an error', async () => {
    const dir = await scratchDir('tree-sitter-')
    const files = await kayFiles()

    await Bun.write(join(dir, 'files.txt'), files.join('\n'))
    const { output } = await run([treeSitter!, 'parse', '--quiet', '--paths', join(dir, 'files.txt')], { libdir: dir })
    const failed = output.split('\n').filter(line => TREE_ERROR.test(line)).map(line => line.replace(`${ROOT}/`, '').replaceAll(/\s+/g, ' '))

    expect(files.length).toBeGreaterThan(100)
    expect(failed).toEqual([])
    expect(output).not.toContain('Error:')
  }, 120_000)

  it('flags a file with an unclosed attribute list', async () => {
    const dir = await scratchDir('tree-sitter-')

    await Bun.write(join(dir, 'broken.kay'), 'div(href=\n  p ))(\n')
    const { output } = await run([treeSitter!, 'parse', '--quiet', join(dir, 'broken.kay')], { libdir: dir })

    expect(output).toMatch(TREE_ERROR)
  })

  it('keeps balancing brackets nested past the scanner stack', async () => {
    const dir = await scratchDir('tree-sitter-')
    const depth = 100

    await Bun.write(join(dir, 'deep.kay'), `div(a={${'{'.repeat(depth)}1${'}'.repeat(depth)}})\n  p x\n`)
    const { output } = await run([treeSitter!, 'parse', '--quiet', join(dir, 'deep.kay')], { libdir: dir })

    expect(output).not.toMatch(TREE_ERROR)
  })

  it('has its generated parser up to date with grammar.js and its scanner', async () => {
    const dir = await scratchDir('tree-sitter-')
    const copy = join(dir, 'tree-sitter-kay')

    await cp(GRAMMAR, copy, { recursive: true })
    const { output, code } = await run([treeSitter!, 'generate'], { cwd: copy, libdir: dir })

    expect(code, output).toBe(0)

    for (const file of ['parser.c', 'grammar.json', 'node-types.json'])
      expect(await Bun.file(join(copy, 'src', file)).text(), `src/${file} is stale, run \`bun run generate\` in editors/tree-sitter-kay`).toBe(await Bun.file(join(GRAMMAR, 'src', file)).text())
  }, 120_000)

  it('has the Zed extension build the grammar from its folder at a release tag', async () => {
    const manifest = await Bun.file(join(ROOT, 'editors/zed/extension.toml')).text()

    expect(manifest).toContain('path = "editors/tree-sitter-kay"')
    expect(manifest).toMatch(/^rev = "(?:v\d+\.\d+\.\d+|unreleased)"$/m)
  })

  it('gives the Zed extension the same queries', async () => {
    const queries = (await readdir(join(GRAMMAR, 'queries'))).toSorted()

    expect(queries).toEqual(['highlights.scm', 'indents.scm', 'injections.scm'])

    for (const query of queries)
      expect(await Bun.file(join(ROOT, 'editors/zed/languages/kay', query)).text(), `editors/zed/languages/kay/${query} differs, run \`bun run sync-zed\` in editors/tree-sitter-kay`).toBe(await Bun.file(join(GRAMMAR, 'queries', query)).text())
  })
})

// Neovim loads the compiled parser and runs the queries the way its highlighter does.
const HIGHLIGHT = `
local text = table.concat(vim.fn.readfile(vim.env.KAY_FILE), '\\n') .. '\\n'
local function read(path) return table.concat(vim.fn.readfile(path), '\\n') end
vim.treesitter.language.add('kay', { path = vim.env.KAY_PARSER })
local tree = vim.treesitter.get_string_parser(text, 'kay'):parse()[1]
local highlights = vim.treesitter.query.parse('kay', read(vim.env.KAY_QUERIES .. '/highlights.scm'))
local captured = {}
for id, node in highlights:iter_captures(tree:root(), text) do
  local name = highlights.captures[id]
  captured[name] = captured[name] or {}
  captured[name][node:type()] = true
end
local injections = vim.treesitter.query.parse('kay', read(vim.env.KAY_QUERIES .. '/injections.scm'))
local injected = {}
for _, match, metadata in injections:iter_matches(tree:root(), text) do
  for id, nodes in pairs(match) do
    if injections.captures[id] == 'injection.content' then
      for _, node in ipairs(type(nodes) == 'table' and nodes or { nodes }) do
        injected[node:type()] = metadata['injection.language']
      end
    end
  end
end
print(vim.json.encode({ captured = captured, injected = injected, error = tree:root():has_error() }))
`

describe.skipIf(treeSitter === null || nvim === null)('tree-sitter grammar in Neovim', () => {
  it('captures the tags, the attributes, the holes and the script fence of a page', async () => {
    const dir = await scratchDir('tree-sitter-nvim-')
    const parser = join(dir, 'kay.so')

    expect((await run([treeSitter!, 'build', '--output', parser, GRAMMAR], { libdir: dir })).code).toBe(0)
    await Bun.write(join(dir, 'highlight.lua'), HIGHLIGHT)

    const page = join(ROOT, 'examples/noticeboard/src/routes/index.kay')
    const env = { ...Bun.env, KAY_FILE: page, KAY_PARSER: parser, KAY_QUERIES: join(GRAMMAR, 'queries') }
    const child = Bun.spawn(['timeout', '60', nvim!, '--clean', '--headless', '-l', join(dir, 'highlight.lua')], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const result = JSON.parse(`${stdout}${stderr}`.trim().split('\n').at(-1)!) as { captured: Record<string, Record<string, boolean>>, injected: Record<string, string>, error: boolean }

    expect(result.error).toBe(false)
    expect(Object.keys(result.captured.tag ?? {})).toContain('tag_name')
    expect(Object.keys(result.captured.attribute ?? {})).toContain('attribute_name')
    expect(Object.keys(result.captured['punctuation.special'] ?? {})).toContain('{')
    expect(result.injected.hole_content).toBe('typescript')
    expect(result.injected.fence_body).toBe('typescript')
  }, 120_000)
})

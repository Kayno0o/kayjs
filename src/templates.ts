import type { ConfigSettings, Feature, Host, Setup } from './template-shared'
import { authFiles, authTestFiles } from './template-auth'
import { pagesWorkflow, testWorkflow } from './template-ci'
import { config, SERVER_ENTRY } from './template-config'
import { serverContainerFiles, staticContainerFiles } from './template-docker'
import { blocks, DEFAULT_RUNNERS, lines, REGISTRY } from './template-shared'
import { home, homeTest, layout, starterFiles } from './template-starter'
import { ACCENT_FILES, editorExtensions, editorSettings, PLAIN_CSS, tailwindCss } from './template-styles'
import { WS_TEST, wsFiles } from './template-ws'

// The files `kay new` writes, `__NAME__` standing for the package name. Written as strings rather than template files, which the repository's own `.kay` scans would pick up.

export { APP_ROLES_SCRIPT } from './template-docker'
export { DEFAULT_RUNNERS } from './template-shared'
export type { ConfigSettings, Feature, Host } from './template-shared'
export { TAILWIND_CLASS_REGEX } from './template-styles'

// The project's AGENTS.md, naming the checks its scripts run. Claude Code expands the `@` line into kay's docs as installed, other agents read it as a path. With `seo`, it names the folder name every title ends with, which an agent otherwise leaves as it is.
export function agentsFile(scripts: Record<string, string>, seo: boolean): string {
  const checks = ['check', 'fmt', 'lint', 'test'].filter(script => script in scripts).map(script => `\`bun run ${script}\``)

  return blocks(
    '# __NAME__',
    'Built with kay, a Bun web framework: a `.kay` file is one component, TypeScript fences then a pug-like template. Read kay\'s docs for the installed version before writing kay code; the topic files they link are in `node_modules/kay/llms/`, and `bunx kay docs <words>` prints the section of them or of an installed library\'s that matches:',
    '@node_modules/kay/llms.txt',
    seo && 'Every page title ends with `seo.name` from `kay.config.ts`, which `kay new` filled in from the folder name: set it to the site\'s real name.',
    `Before calling a change done, run ${new Intl.ListFormat('en').format(checks)}.`,
  )
}

// Every file but package.json, tsconfig.json and the agents' instructions, which `createProject` writes from the same features and scripts.
export function templateFiles(features: ReadonlySet<Feature>, settings: ConfigSettings = {}, host: Host = 'forgejo', runner: string = DEFAULT_RUNNERS[host]): Record<string, string> {
  const has = (feature: Feature) => features.has(feature)
  const setup: Setup = { has, host, runner, tw: classes => has('tailwind') ? classes : '', settings }
  const server = has('server')

  return {
    // kay itself is published there, as are @kaynooo/eslint and @kaynooo/pg-orm.
    '.npmrc': `@kaynooo:registry=${REGISTRY}\n`,
    '.gitignore': lines('node_modules', '.kay', has('eslint') && '.eslintcache', server ? '/server' : 'dist', has('auth') && !has('postgres') && 'data', '.env', '.env.*', '!.env.example', '!.env.test'),
    'kay.config.ts': config(setup),
    'src/routes/_layout.kay': layout(setup),
    'src/routes/index.kay': home(setup),
    ...has('tailwind') && { 'src/app.css': tailwindCss(setup) },
    ...has('starter') && !has('tailwind') && { 'src/app.css': PLAIN_CSS },
    ...has('starter') && starterFiles(setup),
    ...has('accents') && ACCENT_FILES,
    ...server && { 'src/server.ts': SERVER_ENTRY },
    '.vscode/settings.json': `${JSON.stringify(editorSettings(setup), null, 2)}\n`,
    '.vscode/extensions.json': `${JSON.stringify(editorExtensions(setup), null, 2)}\n`,
    // Type-aware, .kay fences included, over the types `kay lint`, `kay check` and `kay dev` write.
    ...has('eslint') && { 'eslint.config.ts': 'import { defineConfig } from \'@kaynooo/eslint\'\n\nexport default defineConfig({ strict: true, kay: true })\n' },
    ...has('tests') && {
      // `kay/test/preload` lets test files import pages and their actions, and gives each one a database of its own when the app has a pg-orm.config.ts.
      'bunfig.toml': '[test]\npreload = [ "kay/test/preload" ]\n',
      'tests/home.test.ts': homeTest(setup),
    },
    ...has('ci') && { [`.${host}/workflows/${server ? 'test' : 'pages'}.yml`]: server ? testWorkflow(setup) : pagesWorkflow(setup) },
    ...has('docker') && (server ? serverContainerFiles(setup) : staticContainerFiles(setup)),
    ...has('auth') && authFiles(setup),
    ...has('auth') && has('tests') && authTestFiles(setup),
    ...has('ws') && wsFiles(setup),
    ...has('ws') && has('tests') && { 'tests/online.test.ts': WS_TEST },
  }
}

// Each command's line of the usage, apart from the commands so `kay <command>` loads only its own code and the usage still lists them all.
export const USAGES = {
  new: 'new <dir> [--kay <dependency>] [--template blank|server|site|app] [--with <features>] [--without <features>] [-y] [--quiet]',
  dev: 'dev [dir] [--entry <file>] [--port <port>] [--host[=<address>]] [--inspect[=<address>]] [--open] [--format text|json] [--quiet]',
  build: 'build [dir] [--compile <executable>] [--entry <file>] [--static] [--outdir <dir>] [--no-check] [--analyze] [-p tsconfig.json] [--format text|github|json] [--quiet]',
  start: 'start [dir] [--entry <file>] [--port <port>]',
  render: 'render <url> [dir] [--entry <file>] [--method <method>] [--body <text>] [--header <name: value>]... [--cookie <name=value>]... [-i|--include]',
  check: 'check [dir] [paths...] [-p tsconfig.json] [--entry <file>] [--deny-warnings] [--fix] [--only <group>] [--format text|github|json] [--watch] [--quiet]',
  routes: 'routes [dir] [--format text|json]',
  explain: 'explain [lint|error|group] [--format text|json]',
  fmt: 'fmt [paths...] [--check] [--format text|json] [--quiet]',
  migrate: 'migrate astro [dir] [--out <dir>] [--format text|json] [--quiet]',
  lsp: 'lsp --stdio',
  mcp: 'mcp [--stdio]',
} as const

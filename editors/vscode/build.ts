// Bundles the extension and its language client into one CommonJS file, so the VSIX ships no node_modules.
const result = await Bun.build({
  entrypoints: ['src/extension.ts'],
  outdir: 'dist',
  target: 'node',
  format: 'cjs',
  external: ['vscode'],
  minify: true,
})

if (!result.success)
  throw new AggregateError(result.logs, 'Extension build failed')

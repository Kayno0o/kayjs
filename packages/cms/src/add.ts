// What `kay add cms` writes: the extension with its defaults.
export default {
  description: 'collection screens under /admin, and content edited on the page it renders',
  extension: { import: 'import { cms } from \'@kaynooo/kayjs-cms\'', expression: 'cms()' },
  notes: ['Before production, set cms({ files, guard }) and preview.secret in kay.config.ts: a production server refuses to boot without files, which saves edits to a forge or a working tree that outlives a deploy.'],
}

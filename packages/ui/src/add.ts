interface Project {
  exists: (path: string) => boolean
}

const TAILWIND_IMPORT = /@import 'tailwindcss';/
const NOTES = ['Import each component from \'@kayjs/ui/<name>.kay\'; the app\'s own @theme in app.css overrides the theme\'s tokens.']

// What `kay add ui` writes: the extension that mounts the theme, one Toaster, one TooltipHost and one ConfirmHost. A static site cannot mount `ui()` (its `/_kay/ui` routes need a server), so its stylesheet imports the theme, as `kay new` writes it.
export default (project: Project) => {
  if (project.exists('src/server.ts')) {
    return {
      description: 'the theme, one Toaster, one TooltipHost and one ConfirmHost for every page, with no line in the layout or app.css',
      extension: { import: 'import { ui } from \'@kayjs/ui\'', expression: 'ui()' },
      notes: NOTES,
    }
  }

  return {
    description: 'the theme, imported by app.css: a static site has no server to mount ui() on',
    edits: [{ file: 'src/app.css', find: TAILWIND_IMPORT, replace: '@import \'tailwindcss\';\n@import \'@kayjs/ui/theme.css\';', done: '@kayjs/ui/theme.css' }],
    notes: NOTES,
  }
}

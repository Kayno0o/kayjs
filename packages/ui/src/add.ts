// What `kay add ui` writes: the extension that mounts the theme, one Toaster and one TooltipHost.
export default {
  description: 'the theme, one Toaster and one TooltipHost for every page, with no line in the layout or app.css',
  extension: { import: 'import { ui } from \'@kaynooo/kayjs-ui/extension\'', expression: 'ui()' },
  notes: ['Import each component from \'@kaynooo/kayjs-ui/<name>.kay\'; the app\'s own @theme in app.css overrides the theme\'s tokens.'],
}

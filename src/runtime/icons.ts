// What `import home from '~icons/tabler/home'` gives: the props an `svg` spreads to draw it, `svg({...home})`, sized to the text around it.
export interface IconProps {
  'viewBox': string
  'width': string
  'height': string
  'aria-hidden': 'true'
  'innerHTML': string
}

import type { Settings } from '@kaynooo/kayjs-mail'
import { cssColours, defaults } from '@kaynooo/kayjs-mail'
import site from './styles/site.css' with { type: 'text' }

const colour = cssColours(site, 'styles/site.css')

export default { ...defaults, accent: colour('--color-brand') } satisfies Settings

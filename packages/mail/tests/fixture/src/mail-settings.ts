import type { Settings } from '@kaynooo/kayjs-mail'
import { cssColours, defaults } from '@kaynooo/kayjs-mail'

const colour = cssColours(new URL('./styles/site.css', import.meta.url))

export default { ...defaults, accent: colour('--color-brand') } satisfies Settings

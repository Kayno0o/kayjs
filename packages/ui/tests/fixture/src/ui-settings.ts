import type { Settings } from '@kaynooo/kayjs-ui'
import { defaults } from '@kaynooo/kayjs-ui'
import close from '~icons/tabler/circle-x'

// The app's own close icon, every other slot as the library has it.
const settings: Settings = { ...defaults, icons: { ...defaults.icons, close } }

export default settings

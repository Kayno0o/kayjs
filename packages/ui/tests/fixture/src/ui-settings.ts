import type { UiSettings } from '@kaynooo/kayjs-ui'
import { uiDefaults } from '@kaynooo/kayjs-ui'
import close from '~icons/tabler/circle-x'

// The app's own close icon, every other slot as the library has it.
const settings: UiSettings = { ...uiDefaults, icons: { ...uiDefaults.icons, close } }

export default settings

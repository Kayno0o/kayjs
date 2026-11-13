import type { UiSettings } from '@kayjs/ui'
import { uiDefaults } from '@kayjs/ui'

const { alert, back, chevron, close, delete: remove, globe, info, menu, play, plus, search, spinner, star, success, zoomFit, zoomIn, zoomOut } = uiDefaults.icons

// A map an app wrote before the pause slot was added: it still type-checks, the carousel drawing the default pause icon.
export const written: UiSettings['icons'] = { alert, back, chevron, close, delete: remove, globe, info, menu, play, plus, search, spinner, star, success, zoomFit, zoomIn, zoomOut }

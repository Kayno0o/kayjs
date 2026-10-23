// The utilities of a list of actions, which Menu and BellInbox draw alike, so a change reaches both.
const BOX = 'flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-sm outline-none hover:bg-hover focus:bg-hover'
// The tint alone is too faint to find, so an accent bar marks the item the keyboard stands on; forced colours drop both and paint the transparent outline instead.
const MARK = 'focus-visible:[box-shadow:inset_2px_0_0_var(--color-accent)] focus-visible:[outline-offset:-2px] focus-visible:[outline:2px_solid_transparent]'

export const MENU_LIST = 'flex flex-col gap-px p-1 outline-none'

export const MENU_ITEM = `${BOX} text-foreground ${MARK}`

// The row under a list that acts on all of it.
export const MENU_FOOTER = `${BOX} ${MARK} border-0 border-t border-solid border-border font-medium text-accent`

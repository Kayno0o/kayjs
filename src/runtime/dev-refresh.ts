import { refresh } from './navigate-api'
import { navigation } from './navigation'

// Development: the refresh `kay dev` makes of the page for an edit, keeping what was typed into the fields the edit leaves as they were.
export async function refreshForEdit(): Promise<void> {
  navigation.typed = true

  try {
    await refresh()
  }
  finally {
    navigation.typed = false
  }
}

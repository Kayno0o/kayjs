import type { AppStore } from '../../src/server/app-store'
import { scratchDir } from '../scratch'

// A store whose SQLite file is in a scratch folder, for a production server a test builds: it counts the paths it answered 404 in `data/not-found.sqlite` of the working folder unless the app's store names a file, which would leave that file in the checkout.
export async function scratchStore(): Promise<AppStore> {
  return { database: `sqlite://${await scratchDir('not-found-store-')}/not-found.sqlite` }
}

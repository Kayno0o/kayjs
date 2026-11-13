import { databases } from './dev-data'
import { maintenanceOverview } from './maintenance'
import { queueAdmins } from './queue'

// Whether the app has what the Data and Jobs tabs show: a database, a queue or a maintenance task. The dev tool takes a tab with nothing to show out of its list.
export interface DevOffered {
  data: boolean
  jobs: boolean
}

export function devOffered(root: string): DevOffered {
  return { data: databases(root).length > 0, jobs: queueAdmins().length > 0 || maintenanceOverview().length > 0 }
}

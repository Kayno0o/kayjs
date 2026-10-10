import { collection } from 'kay/content'
import Chart from './components/chart.kay'
import Tabs from './components/tabs.kay'
import Unused from './components/unused.kay'
import { connect } from './db'

export const posts = collection('content/posts', { components: { Chart } })
const notes = collection('content/notes', { components: { Note: Tabs } })

export { notes }
// Server code that reaches a component and a stylesheet without handing them to a collection.
export const db = connect(Unused)

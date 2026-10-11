import { Site } from '../../components/site'
import { Table } from '../../components/table'

export const dynamic = 'force-dynamic'

export default function TablePage() {
  return (
    <Site page="table">
      <h1>Table</h1>
      <Table />
    </Site>
  )
}

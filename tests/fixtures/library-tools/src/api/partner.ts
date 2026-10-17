import { actionTool } from 'kay/library'
import { api } from 'kay/server'
import { addNote } from '../routes/targets/_actions.kay'

// A module another site may call, whose requests a tool call takes as the module let them in.
export default api({ cors: { origins: ['https://partner.example'] } }).get('/', async ({ request }) => actionTool(addNote)!.call({ title: 'Milk' }, request))

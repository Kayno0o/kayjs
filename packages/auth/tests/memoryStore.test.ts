import { memoryStore } from '../src/memoryStore'
import { storeContract } from './helpers/storeContract'

storeContract('memoryStore', async () => memoryStore())

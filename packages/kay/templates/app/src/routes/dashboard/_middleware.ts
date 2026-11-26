import { auth } from '../../auth'

export default auth.guard({ redirectTo: '/login' })

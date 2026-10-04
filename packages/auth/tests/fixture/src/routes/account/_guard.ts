import { auth } from '../../auth'

export default auth.guard({ redirect: '/login' })

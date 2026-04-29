import { NextApiRequest, NextApiResponse } from 'next'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'geekoncloud2025'

export function checkAuth(req: NextApiRequest): boolean {
  const token = req.cookies['admin_token']
  return token === Buffer.from(ADMIN_PASSWORD).toString('base64')
}

export function requireAuth(req: NextApiRequest, res: NextApiResponse): boolean {
  if (!checkAuth(req)) {
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  return true
}

import type { NextApiRequest, NextApiResponse } from 'next'
import { serialize } from 'cookie'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'geekoncloud2025'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  const { password } = req.body
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' })

  const token = Buffer.from(ADMIN_PASSWORD).toString('base64')
  res.setHeader('Set-Cookie', serialize('admin_token', token, {
    httpOnly: true, sameSite: 'strict', path: '/', maxAge: 60 * 60 * 24 * 30
  }))
  res.status(200).json({ ok: true })
}

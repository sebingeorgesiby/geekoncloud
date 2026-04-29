import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../../lib/auth'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!requireAuth(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const { prompt } = req.body
  if (!prompt) return res.status(400).json({ error: 'prompt required' })

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: 'You are an expert DevOps and Cloud Infrastructure technical writer for geekoncloud.com. Write with practitioner-level depth, real examples, and a direct, no-fluff voice. Use markdown formatting.',
      messages: [{ role: 'user', content: prompt }],
    })
    const content = message.content.map(b => b.type === 'text' ? b.text : '').join('')
    res.status(200).json({ content })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}

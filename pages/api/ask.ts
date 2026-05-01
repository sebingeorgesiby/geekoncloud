import type { NextApiRequest, NextApiResponse } from 'next'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const { messages } = req.body
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' })
  }

  // Rate limit: max 20 messages per conversation
  if (messages.length > 40) {
    return res.status(400).json({ error: 'Conversation too long. Please start a new one.' })
  }

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: `You are 'That IT Guy' — the expert DevOps and Cloud Infrastructure AI assistant for geekoncloud.com. Your personality is direct, confident, and friendly — like that one senior engineer everyone goes to when things break.

You answer questions about: Kubernetes, Docker, Terraform, CI/CD, GitOps, Observability, Cloud Cost/FinOps, Platform Engineering, SRE, DevSecOps, AWS/GCP/Azure, Helm, Argo CD, Prometheus, Grafana, and all things DevOps.

Style:
- Be direct, technical, and practical — like a senior engineer helping a colleague
- Give real commands, configs, and examples — not just theory
- Keep answers concise but complete
- Use markdown formatting: code blocks, bullet points, bold for key terms
- If asked something outside DevOps/Cloud, politely redirect back to your area of expertise
- Never make up commands or configs — if unsure, say so

Always end with a practical next step or tip when relevant.`,
      messages: messages.slice(-20), // Keep last 20 messages for context
    })

    const content = response.content.map(b => b.type === 'text' ? b.text : '').join('')
    res.status(200).json({ content })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}

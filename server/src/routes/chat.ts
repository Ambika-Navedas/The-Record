import { Router } from 'express'
import { pool } from '../db.ts'
import { requireAuth } from '../auth.ts'
import { answerQuestionWithAgent } from '../chatAgent.ts'

export const chatRouter = Router()
chatRouter.use(requireAuth)

chatRouter.post('/ask', async (req, res) => {
  const orgId = req.user!.org_id
  const { question } = req.body as { question?: string }
  if (!question || !question.trim()) {
    res.status(400).json({ error: 'question is required' })
    return
  }

  const { text, sources: sourceDocs } = await answerQuestionWithAgent(orgId, question)

  // Lightweight popularity signal: bump the view count on every cited document.
  // No question text or user identity is stored — just a counter on the document itself.
  // Sequential, not Promise.all — matches the ordering-only guarantee this loop always had
  // (no real transaction, same as the old sync-SQLite version), without grabbing more than
  // one pool connection for one logical request.
  for (const doc of sourceDocs) {
    await pool.query('UPDATE knowledge_documents SET view_count = view_count + 1 WHERE id = $1', [doc.id])
  }

  res.json({ answerText: text, sources: sourceDocs })
})

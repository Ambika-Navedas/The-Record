import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'

import './db.ts'
import { authRouter } from './routes/auth.ts'
import { projectsRouter } from './routes/projects.ts'
import { meetingsRouter } from './routes/meetings.ts'
import { knowledgeRouter } from './routes/knowledge.ts'
import { dashboardRouter } from './routes/dashboard.ts'
import { chatRouter } from './routes/chat.ts'
import { searchRouter } from './routes/search.ts'
import { usersRouter } from './routes/users.ts'
import { integrationsRouter } from './routes/integrations.ts'
import { tasksRouter } from './routes/tasks.ts'
import { holidaysRouter } from './routes/holidays.ts'
import { worknestRouter } from './routes/worknest.ts'
import { notificationsRouter } from './routes/notifications.ts'
import { remindersRouter } from './routes/reminders.ts'

// Split out from index.ts so the Express app itself is importable without also starting a
// long-running listener — index.ts (local/traditional-host dev entry, calls app.listen()) and
// api/index.ts (Vercel's serverless entry, just exports this) both need the same app, built
// once. Not a behavior change for local dev — `npm run dev` still does exactly what it did
// before, just via index.ts importing this instead of building the app inline.
export const app = express()

// CORS_ORIGINS is a comma-separated allowlist (e.g. "https://the-record.vercel.app") — set it in
// production to whatever the real deployed frontend origin is. Falls back to the local Vite dev
// server origins, so local dev is unaffected by leaving it unset. Same "configurable via env,
// defaults preserve today's behavior" shape as API_BASE_URL on the frontend side.
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:4173']
app.use(cors({ origin: allowedOrigins, credentials: true }))
app.use(express.json())
app.use(cookieParser())

app.use('/api/auth', authRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/meetings', meetingsRouter)
app.use('/api/knowledge', knowledgeRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/api/chat', chatRouter)
app.use('/api/search', searchRouter)
app.use('/api/users', usersRouter)
app.use('/api/integrations', integrationsRouter)
app.use('/api/tasks', tasksRouter)
app.use('/api/holidays', holidaysRouter)
app.use('/api/worknest', worknestRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/reminders', remindersRouter)

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  res.status(500).json({ error: 'internal_error' })
})

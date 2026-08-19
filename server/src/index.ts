import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'

// Loads ZOOM_CLIENT_ID/SECRET and GOOGLE_CLIENT_ID/SECRET for the integrations router
// (see server/.env.example) — optional, so a missing .env just leaves those unconfigured
// rather than crashing the server.
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

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

const app = express()

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:4173'], credentials: true }))
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

const PORT = 4000
app.listen(PORT, () => {
  console.log(`The Record API listening on http://localhost:${PORT}`)
})

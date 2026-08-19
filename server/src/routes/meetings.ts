import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import multer from 'multer'
import { pool } from '../db.ts'
import { requireAuth } from '../auth.ts'
import { notify } from '../notifications.ts'
import {
  attendMeeting,
  closeOpenTaskAssignment,
  linkTaskToProject,
  recordActivity,
  recordProjectInvolvement,
  recordTaskAssignment,
  upsertMeeting,
  upsertTask,
} from '../graph.ts'
import { UPLOADS_ROOT } from '../uploadsPath.ts'

export const meetingsRouter = Router()
meetingsRouter.use(requireAuth)

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(UPLOADS_ROOT, String(req.params.id))
      mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (_req, file, cb) => cb(null, `${randomUUID()}-${file.originalname}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB — generous enough for an audio recording
})

interface MeetingRow {
  id: string
  title: string
  summary: string
  participants: string
  scheduled_at: string
  duration_min: number
  sync_status: string
  source: string
  project_name: string | null
}

interface ParticipantDescriptor {
  userId: string | null
  name: string
  initials: string | null
  email: string | null
}

// Participants used to be stored as a plain array of internal user ids (seed.ts still writes
// this shape). Real Zoom/Google invitees are email addresses that may not match an org member
// at all, so newer rows (see integrations.ts) store richer descriptor objects instead. This
// resolves either shape into the same output so the frontend never has to care which one it got.
async function resolveParticipants(raw: string, orgId: string): Promise<ParticipantDescriptor[]> {
  const parsed = JSON.parse(raw) as unknown[]
  const out: ParticipantDescriptor[] = []
  for (const entry of parsed) {
    if (typeof entry === 'string') {
      const user = (
        await pool.query('SELECT id, name, initials FROM users WHERE id = $1 AND org_id = $2', [entry, orgId])
      ).rows[0] as { id: string; name: string; initials: string } | undefined
      out.push(
        user
          ? { userId: user.id, name: user.name, initials: user.initials, email: null }
          : { userId: null, name: 'Unknown', initials: null, email: null },
      )
    } else {
      out.push(entry as ParticipantDescriptor)
    }
  }
  return out
}

async function serialize(row: MeetingRow, orgId: string) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    participants: await resolveParticipants(row.participants, orgId),
    scheduledAt: row.scheduled_at,
    durationMin: row.duration_min,
    syncStatus: row.sync_status,
    source: row.source,
    project: row.project_name,
  }
}

interface AssetRow {
  id: string
  filename: string
  mime_type: string
  size_bytes: number
  uploaded_by: string
  uploader_name: string
  created_at: string
}

function serializeAsset(row: AssetRow) {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    uploadedBy: { id: row.uploaded_by, name: row.uploader_name },
    createdAt: row.created_at,
  }
}

interface TaskRow {
  id: string
  title: string
  assignee_id: string | null
  assignee_name: string | null
  assignee_initials: string | null
  due_date: string | null
  done: number
  completion_note: string | null
  created_at: string
}

function serializeTask(row: TaskRow) {
  return {
    id: row.id,
    title: row.title,
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name, initials: row.assignee_initials } : null,
    dueDate: row.due_date,
    done: !!row.done,
    completionNote: row.completion_note,
    createdAt: row.created_at,
  }
}

// Shared by every /:id sub-route (detail, assets, tasks) — confirms the meeting exists and
// belongs to the requester's org before doing anything scoped to it.
async function findMeeting(orgId: string, meetingId: string): Promise<{ id: string; project_id: string | null } | undefined> {
  const { rows } = await pool.query('SELECT id, project_id FROM meetings WHERE org_id = $1 AND id = $2', [
    orgId,
    meetingId,
  ])
  return rows[0] as { id: string; project_id: string | null } | undefined
}

async function isValidAssignee(orgId: string, userId: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM users WHERE id = $1 AND org_id = $2', [userId, orgId])
  return rows.length > 0
}

meetingsRouter.get('/', async (req, res) => {
  const orgId = req.user!.org_id
  const filter = req.query.filter as string | undefined

  let sql = `
    SELECT m.id, m.title, m.summary, m.participants, m.scheduled_at, m.duration_min, m.sync_status, m.source,
           p.name AS project_name
    FROM meetings m
    LEFT JOIN projects p ON p.id = m.project_id
    WHERE m.org_id = $1
  `
  const params: string[] = [orgId]

  if (filter === 'this_week') {
    sql += " AND m.scheduled_at >= now() - interval '7 days'"
  } else if (filter === 'needs_review') {
    sql += " AND m.sync_status = 'processing'"
  }
  sql += ' ORDER BY m.scheduled_at DESC'

  const rows = (await pool.query(sql, params)).rows as MeetingRow[]
  const items = await Promise.all(rows.map((r) => serialize(r, orgId)))
  res.json({ items })
})

meetingsRouter.get('/:id', async (req, res) => {
  const orgId = req.user!.org_id
  const row = (
    await pool.query(
      `SELECT m.id, m.title, m.summary, m.participants, m.scheduled_at, m.duration_min, m.sync_status, m.source,
              p.name AS project_name
       FROM meetings m LEFT JOIN projects p ON p.id = m.project_id
       WHERE m.org_id = $1 AND m.id = $2`,
      [orgId, req.params.id],
    )
  ).rows[0] as MeetingRow | undefined
  if (!row) {
    res.status(404).json({ error: 'not_found' })
    return
  }

  const assetRows = (
    await pool.query(
      `SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.uploaded_by, u.name AS uploader_name, a.created_at
       FROM meeting_assets a JOIN users u ON u.id = a.uploaded_by
       WHERE a.meeting_id = $1 ORDER BY a.created_at DESC`,
      [req.params.id],
    )
  ).rows as AssetRow[]

  const taskRows = (
    await pool.query(
      `SELECT t.id, t.title, t.assignee_id, u.name AS assignee_name, u.initials AS assignee_initials, t.due_date, t.done, t.completion_note, t.created_at
       FROM meeting_tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.meeting_id = $1 ORDER BY t.done ASC, t.due_date IS NULL, t.due_date ASC`,
      [req.params.id],
    )
  ).rows as TaskRow[]

  res.json({
    ...(await serialize(row, orgId)),
    assets: assetRows.map(serializeAsset),
    tasks: taskRows.map(serializeTask),
  })
})

meetingsRouter.post('/', async (req, res) => {
  const orgId = req.user!.org_id
  const { title, summary, projectId, durationMin, scheduledAt, participantIds } = req.body as {
    title?: string
    summary?: string
    projectId?: string
    durationMin?: number
    scheduledAt?: string
    participantIds?: string[]
  }
  if (!title) {
    res.status(400).json({ error: 'title is required' })
    return
  }
  // Validated the same way task assignees are — every id must belong to this org. Stored as a
  // plain array of user ids (the "old" shape resolveParticipants() already handles), not the
  // richer {userId,name,initials,email} descriptors integrations.ts writes for synced meetings —
  // there's no external-guest-email concept for a manually created meeting, only real org members.
  const ids = Array.isArray(participantIds) ? [...new Set(participantIds.filter((v) => typeof v === 'string'))] : []
  for (const pid of ids) {
    if (!(await isValidAssignee(orgId, pid))) {
      res.status(400).json({ error: 'participantIds must all belong to your organization' })
      return
    }
  }
  const id = randomUUID()
  // Written explicitly as a JS ISO timestamp, not SQL-side now() — see dashboard/backend.md's
  // date-comparison bug writeup for why the two formats used to be able to mix badly.
  const now = new Date().toISOString()
  const scheduled = scheduledAt ? new Date(scheduledAt).toISOString() : now
  await pool.query(
    `INSERT INTO meetings (id, org_id, project_id, title, summary, participants, scheduled_at, duration_min, sync_status, source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'synced', 'manual_upload', $9)`,
    [id, orgId, projectId ?? null, title, summary ?? '', JSON.stringify(ids), scheduled, durationMin ?? 30, now],
  )
  await upsertMeeting(id, title, projectId ?? null)
  for (const pid of ids) await attendMeeting(id, pid)
  // Notifies every added participant except the creator (who already knows — they just made it).
  for (const pid of ids) {
    if (pid === req.user!.id) continue
    await notify(orgId, pid, `You were added to a meeting: ${title}.`)
  }
  res.status(201).json({ id, title })
})

// --- Assets (real file uploads — recordings, etc.) ---

meetingsRouter.post('/:id/assets', upload.single('file'), async (req, res) => {
  const orgId = req.user!.org_id
  const meetingId = String(req.params.id)
  if (!(await findMeeting(orgId, meetingId))) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (!req.file) {
    res.status(400).json({ error: 'file is required' })
    return
  }
  const id = randomUUID()
  await pool.query(
    `INSERT INTO meeting_assets (id, meeting_id, org_id, filename, mime_type, size_bytes, storage_path, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      meetingId,
      orgId,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      path.join(meetingId, req.file.filename),
      req.user!.id,
    ],
  )
  res.status(201).json({
    id,
    filename: req.file.originalname,
    mimeType: req.file.mimetype,
    sizeBytes: req.file.size,
    uploadedBy: { id: req.user!.id, name: req.user!.name },
    createdAt: new Date().toISOString(),
  })
})

meetingsRouter.get('/:id/assets/:assetId/download', async (req, res) => {
  const orgId = req.user!.org_id
  const asset = (
    await pool.query(
      'SELECT filename, mime_type, storage_path FROM meeting_assets WHERE org_id = $1 AND meeting_id = $2 AND id = $3',
      [orgId, req.params.id, req.params.assetId],
    )
  ).rows[0] as { filename: string; mime_type: string; storage_path: string } | undefined
  if (!asset) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const filePath = path.join(UPLOADS_ROOT, asset.storage_path)
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'file_missing' })
    return
  }
  res.download(filePath, asset.filename)
})

meetingsRouter.delete('/:id/assets/:assetId', async (req, res) => {
  const orgId = req.user!.org_id
  const asset = (
    await pool.query('SELECT storage_path FROM meeting_assets WHERE org_id = $1 AND meeting_id = $2 AND id = $3', [
      orgId,
      req.params.id,
      req.params.assetId,
    ])
  ).rows[0] as { storage_path: string } | undefined
  if (!asset) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  await pool.query('DELETE FROM meeting_assets WHERE id = $1', [req.params.assetId])
  const filePath = path.join(UPLOADS_ROOT, asset.storage_path)
  if (existsSync(filePath)) unlinkSync(filePath)
  res.status(204).end()
})

// --- Tasks (per-meeting action items with assignee + due date) ---

meetingsRouter.post('/:id/tasks', async (req, res) => {
  const orgId = req.user!.org_id
  const meeting = await findMeeting(orgId, req.params.id)
  if (!meeting) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const { title, assigneeId, dueDate } = req.body as { title?: string; assigneeId?: string; dueDate?: string }
  if (!title) {
    res.status(400).json({ error: 'title is required' })
    return
  }
  if (assigneeId && !(await isValidAssignee(orgId, assigneeId))) {
    res.status(400).json({ error: 'assigneeId must belong to your organization' })
    return
  }
  const id = randomUUID()
  const now = new Date().toISOString()
  await pool.query(
    `INSERT INTO meeting_tasks (id, meeting_id, org_id, title, assignee_id, due_date)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, req.params.id, orgId, title, assigneeId ?? null, dueDate ?? null],
  )
  await upsertTask(id, title, req.params.id)
  if (meeting.project_id) await linkTaskToProject(id, meeting.project_id)
  if (assigneeId) {
    await notify(orgId, assigneeId, `You were assigned a task: ${title}.`)
    // Loosely "attended" — really "connected to this meeting via an assigned action item," a
    // real, already-collected signal reused for graph attendance edges rather than modeling a
    // separate, stricter "actually attended" concept this app has no data source for.
    await attendMeeting(req.params.id, assigneeId)
    // Closes a real gap: task_activity previously only ever logged a *re*assignment, never the
    // initial one at creation time — meaning most tasks had no assignment history at all, just a
    // current value with no "since when." Logged the same way a real reassignment is, so the
    // temporal graph's ASSIGNED_TO history is complete from a task's very first assignment.
    const activityId = randomUUID()
    await pool.query(
      'INSERT INTO task_activity (id, org_id, task_id, actor_id, action, assignee_id, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [activityId, orgId, id, req.user!.id, 'assigned', assigneeId, 'Assigned at creation'],
    )
    await recordTaskAssignment(id, assigneeId, now, null)
    await recordActivity(activityId, 'assigned', now, req.user!.id, 'Task', id)
    if (meeting.project_id) await recordProjectInvolvement(assigneeId, meeting.project_id, now)
  }
  res.status(201).json({ id })
})

meetingsRouter.patch('/:id/tasks/:taskId', async (req, res) => {
  const orgId = req.user!.org_id
  const existing = (
    await pool.query(
      'SELECT id, title, assignee_id FROM meeting_tasks WHERE org_id = $1 AND meeting_id = $2 AND id = $3',
      [orgId, req.params.id, req.params.taskId],
    )
  ).rows[0] as { id: string; title: string; assignee_id: string | null } | undefined
  if (!existing) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const { title, assigneeId, dueDate, done, note, reason } = req.body as {
    title?: string
    assigneeId?: string | null
    dueDate?: string | null
    done?: boolean
    note?: string
    reason?: string
  }
  if (assigneeId && !(await isValidAssignee(orgId, assigneeId))) {
    res.status(400).json({ error: 'assigneeId must belong to your organization' })
    return
  }
  // Actually assigning/reassigning to someone (not clearing, not re-selecting the current
  // assignee) requires a short reason — logged to task_activity so the "why" survives, not just
  // the "who." Clearing an assignee needs no justification; there's no one to explain it to.
  const isReassignment = assigneeId !== undefined && !!assigneeId && assigneeId !== existing.assignee_id
  if (isReassignment && !reason?.trim()) {
    res.status(400).json({ error: 'reason_required', message: 'A short reason for this assignment is required.' })
    return
  }
  // Only the person a task is actually assigned to can mark it done or reopen it. An unassigned
  // task has no "concerned person" yet, so it must be assigned before anyone can complete it.
  if (done !== undefined) {
    if (!existing.assignee_id) {
      res.status(403).json({ error: 'not_assigned', message: 'Assign this task to someone before it can be marked done.' })
      return
    }
    if (existing.assignee_id !== req.user!.id) {
      res.status(403).json({ error: 'not_assignee', message: 'Only the person this task is assigned to can mark it done.' })
      return
    }
  }
  if (done === true && !note?.trim()) {
    res.status(400).json({ error: 'note_required', message: 'A short note explaining the completion is required.' })
    return
  }
  if (title !== undefined) await pool.query('UPDATE meeting_tasks SET title = $1 WHERE id = $2', [title, req.params.taskId])
  if (assigneeId !== undefined)
    await pool.query('UPDATE meeting_tasks SET assignee_id = $1 WHERE id = $2', [assigneeId, req.params.taskId])
  if (dueDate !== undefined)
    await pool.query('UPDATE meeting_tasks SET due_date = $1 WHERE id = $2', [dueDate, req.params.taskId])
  if (done !== undefined) {
    await pool.query('UPDATE meeting_tasks SET done = $1, completion_note = $2 WHERE id = $3', [
      done ? 1 : 0,
      done ? note!.trim() : null,
      req.params.taskId,
    ])
  }
  const now = new Date().toISOString()
  if (isReassignment) {
    // assigneeId is truthy here by isReassignment's own definition — the notification uses
    // whatever title this same request set (title !== undefined) or the pre-existing one,
    // since a title change and a reassignment can land in the same PATCH.
    await notify(orgId, assigneeId!, `You were assigned a task: ${title ?? existing.title}.`)
    await attendMeeting(req.params.id, assigneeId!)
    const activityId = randomUUID()
    await pool.query(
      'INSERT INTO task_activity (id, org_id, task_id, actor_id, action, assignee_id, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [activityId, orgId, req.params.taskId, req.user!.id, 'assigned', assigneeId, reason!.trim()],
    )
    // A live reassignment, unlike the backfill, can't look ahead to know when the *next* period
    // starts — so it's always two writes: close whatever's currently open, then open the new one.
    await closeOpenTaskAssignment(req.params.taskId, now)
    await recordTaskAssignment(req.params.taskId, assigneeId!, now, null)
    await recordActivity(activityId, 'assigned', now, req.user!.id, 'Task', req.params.taskId)
    const meeting = await findMeeting(orgId, req.params.id)
    if (meeting?.project_id) await recordProjectInvolvement(assigneeId!, meeting.project_id, now)
  }
  if (done !== undefined) {
    const activityId = randomUUID()
    await pool.query(
      'INSERT INTO task_activity (id, org_id, task_id, actor_id, action, assignee_id, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [
        activityId,
        orgId,
        req.params.taskId,
        req.user!.id,
        done ? 'done' : 'reopened',
        existing.assignee_id,
        done ? note!.trim() : null,
      ],
    )
    await recordActivity(activityId, done ? 'done' : 'reopened', now, req.user!.id, 'Task', req.params.taskId)
  }
  res.status(204).end()
})

meetingsRouter.get('/:id/tasks/:taskId/activity', async (req, res) => {
  const orgId = req.user!.org_id
  const task = (
    await pool.query('SELECT id FROM meeting_tasks WHERE org_id = $1 AND meeting_id = $2 AND id = $3', [
      orgId,
      req.params.id,
      req.params.taskId,
    ])
  ).rows[0]
  if (!task) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const rows = (
    await pool.query(
      `SELECT a.id, a.action, a.reason, a.created_at,
              actor.name AS actor_name,
              assignee.name AS assignee_name
       FROM task_activity a
       JOIN users actor ON actor.id = a.actor_id
       LEFT JOIN users assignee ON assignee.id = a.assignee_id
       WHERE a.org_id = $1 AND a.task_id = $2
       ORDER BY a.created_at ASC`,
      [orgId, req.params.taskId],
    )
  ).rows as {
    id: string
    action: string
    reason: string | null
    created_at: string
    actor_name: string
    assignee_name: string | null
  }[]
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorName: r.actor_name,
      assigneeName: r.assignee_name,
      reason: r.reason,
      createdAt: r.created_at,
    })),
  })
})

meetingsRouter.delete('/:id/tasks/:taskId', async (req, res) => {
  const orgId = req.user!.org_id
  const existing = (
    await pool.query('SELECT id, assignee_id FROM meeting_tasks WHERE org_id = $1 AND meeting_id = $2 AND id = $3', [
      orgId,
      req.params.id,
      req.params.taskId,
    ])
  ).rows[0] as { id: string; assignee_id: string | null } | undefined
  if (!existing) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  // Assigned tasks are someone's responsibility, so only that person can remove it from their
  // plate — unlike completion, an unassigned task has no owner to defer to, so cleaning up junk
  // (e.g. a bad auto-extraction) stays open to anyone rather than getting locked like completion is.
  if (existing.assignee_id && existing.assignee_id !== req.user!.id) {
    res.status(403).json({ error: 'not_assignee', message: 'Only the person this task is assigned to can delete it.' })
    return
  }
  // task_activity.task_id references this row with FK enforcement on — any task that's ever been
  // reassigned-with-reason or marked done/reopened has activity rows, so those must go first or
  // the delete below fails with a foreign key constraint error.
  await pool.query('DELETE FROM task_activity WHERE task_id = $1', [req.params.taskId])
  await pool.query('DELETE FROM meeting_tasks WHERE id = $1', [req.params.taskId])
  res.status(204).end()
})

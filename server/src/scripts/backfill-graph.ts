// One-off backfill: sync-on-write (wired into projects.ts, meetings.ts, knowledge.ts,
// integrations.ts) only covers writes going forward — it does nothing for rows that already
// existed in Postgres before Neo4j was added. This walks the current org data once and
// populates the graph from it, so "expand via relationships" has something real to expand
// into immediately, not just for content created after this point. Safe to re-run — every
// graph.ts helper is a MERGE, not a CREATE.
import { pool } from '../db.ts'
import { attendMeeting, closeDriver, upsertDocument, upsertMeeting, upsertProject } from '../graph.ts'

async function main() {
  const projects = (await pool.query('SELECT id, name FROM projects')).rows as { id: string; name: string }[]
  for (const p of projects) {
    await upsertProject(p.id, p.name)
  }
  console.log(`projects: synced ${projects.length}`)

  const meetings = (await pool.query('SELECT id, title, project_id, participants FROM meetings')).rows as {
    id: string
    title: string
    project_id: string | null
    participants: string
  }[]
  let attendCount = 0
  for (const m of meetings) {
    await upsertMeeting(m.id, m.title, m.project_id)
    const parsed = JSON.parse(m.participants) as unknown[]
    for (const entry of parsed) {
      // Same two coexisting shapes meetings.ts's resolveParticipants() already handles: a
      // plain user-id string (legacy/manual), or a {userId,...} descriptor (synced). Either
      // way, only entries with a real internal user id can become an ATTENDED_BY edge.
      const userId = typeof entry === 'string' ? entry : (entry as { userId: string | null }).userId
      if (userId) {
        await attendMeeting(m.id, userId)
        attendCount++
      }
    }
  }
  // Task-assignee-derived attendance — a retroactive fix for real data, added after the first
  // run of this script found zero graph-expansion results: the org's real meetings (mostly
  // auto-created from synced Gmail summaries) never had real `participants` data, but the
  // *tasks* extracted from those same summaries already have real `assignee_id`s. "Assigned an
  // action item from this meeting" is a reasonable stand-in for "connected to this meeting,"
  // and it's a signal that already fully exists — no new parsing needed. Also now a live
  // sync-on-write hook (meetings.ts's task create/reassign, integrations.ts's auto-extraction),
  // so this backfill step exists only to catch tasks that were assigned *before* that hook did.
  const taskAssignees = (
    await pool.query(
      'SELECT DISTINCT meeting_id, assignee_id FROM meeting_tasks WHERE assignee_id IS NOT NULL',
    )
  ).rows as { meeting_id: string; assignee_id: string }[]
  for (const t of taskAssignees) {
    await attendMeeting(t.meeting_id, t.assignee_id)
    attendCount++
  }
  console.log(`meetings: synced ${meetings.length} (${attendCount} attendance edges, incl. task-assignee-derived)`)

  const docs = (
    await pool.query(
      'SELECT id, title, type, project_id, source_meeting_id FROM knowledge_documents WHERE deleted_at IS NULL',
    )
  ).rows as { id: string; title: string; type: string; project_id: string | null; source_meeting_id: string | null }[]
  for (const d of docs) {
    await upsertDocument(d.id, d.title, d.type, d.project_id, d.source_meeting_id)
  }
  console.log(`knowledge_documents: synced ${docs.length}`)

  await pool.end()
  await closeDriver()
  console.log('Backfill complete.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

// One-off backfill: turns real historical event data already sitting in Postgres — task_activity,
// project ownership — into the temporal graph structures described in graph.ts's "Temporal
// knowledge graph" section. Safe to re-run (every write is a MERGE keyed on a timestamp or a
// stable id).
import { pool } from '../db.ts'
import {
  closeDriver,
  linkTaskToProject,
  recordActivity,
  recordProjectInvolvement,
  recordTaskAssignment,
  upsertTask,
} from '../graph.ts'

async function main() {
  const tasks = (
    await pool.query('SELECT id, title, meeting_id, mt.due_date FROM meeting_tasks mt')
  ).rows as { id: string; title: string; meeting_id: string; due_date: string | null }[]
  for (const t of tasks) {
    await upsertTask(t.id, t.title, t.meeting_id)
  }
  console.log(`tasks: synced ${tasks.length} Task nodes`)

  // Task-PART_OF-Project — derived one hop through each task's meeting (see backend.md: a task's
  // project affiliation is never stored directly). Zero edges is the honest, correct result today
  // — no real meeting in this org has a project_id set yet — but this keeps the sync ready for
  // the moment one does, rather than needing a separate pass added later.
  const taskProjectLinks = (
    await pool.query(
      `SELECT mt.id AS task_id, m.project_id
       FROM meeting_tasks mt
       JOIN meetings m ON m.id = mt.meeting_id
       WHERE m.project_id IS NOT NULL`,
    )
  ).rows as { task_id: string; project_id: string }[]
  for (const row of taskProjectLinks) {
    await linkTaskToProject(row.task_id, row.project_id)
  }
  console.log(`task-project links: synced ${taskProjectLinks.length}`)

  // Person-WORKED_ON-Project — real signals only. (1) every project's current owner, backfilled
  // from the project's own created_at since there's no project_history row predating this
  // feature to give an earlier signal. (2) anyone assigned a task whose meeting has a project —
  // same "zero today, ready when real data exists" honesty as the PART_OF pass above.
  const projects = (await pool.query('SELECT id, owner_id, created_at FROM projects')).rows as {
    id: string
    owner_id: string
    created_at: Date
  }[]
  for (const p of projects) {
    await recordProjectInvolvement(p.owner_id, p.id, p.created_at.toISOString())
  }
  console.log(`project ownership involvement: synced ${projects.length}`)

  const taskAssigneeProjectLinks = (
    await pool.query(
      `SELECT mt.assignee_id, m.project_id, mt.created_at
       FROM meeting_tasks mt
       JOIN meetings m ON m.id = mt.meeting_id
       WHERE m.project_id IS NOT NULL AND mt.assignee_id IS NOT NULL`,
    )
  ).rows as { assignee_id: string; project_id: string; created_at: Date }[]
  for (const row of taskAssigneeProjectLinks) {
    await recordProjectInvolvement(row.assignee_id, row.project_id, row.created_at.toISOString())
  }
  console.log(`task-assignee project involvement: synced ${taskAssigneeProjectLinks.length}`)

  // ASSIGNED_TO — each task's real assignment periods, reconstructed from task_activity's
  // 'assigned' events (chronological per task; the last one is always open-ended).
  const events = (
    await pool.query(
      `SELECT task_id, assignee_id, created_at FROM task_activity
       WHERE action = 'assigned' AND assignee_id IS NOT NULL
       ORDER BY task_id, created_at ASC`,
    )
  ).rows as { task_id: string; assignee_id: string; created_at: Date }[]

  const byTask = new Map<string, { assignee_id: string; created_at: Date }[]>()
  for (const e of events) {
    const list = byTask.get(e.task_id) ?? []
    list.push({ assignee_id: e.assignee_id, created_at: e.created_at })
    byTask.set(e.task_id, list)
  }

  let edgeCount = 0
  let reassignedTaskCount = 0
  for (const [taskId, periods] of byTask) {
    if (periods.length > 1) reassignedTaskCount++
    for (let i = 0; i < periods.length; i++) {
      const validFrom = periods[i].created_at.toISOString()
      const validTo = i + 1 < periods.length ? periods[i + 1].created_at.toISOString() : null
      await recordTaskAssignment(taskId, periods[i].assignee_id, validFrom, validTo)
      edgeCount++
    }
  }
  console.log(
    `assignment history: synced ${edgeCount} time-bounded edges across ${byTask.size} tasks (${reassignedTaskCount} of them actually reassigned at least once)`,
  )

  // Activity nodes — one per real task_activity row, whatever the action (assigned/done/reopened),
  // giving every event its own identity instead of only ever living as an ASSIGNED_TO edge
  // property. Small real volume today (15 rows) — this is a full, not partial, backfill.
  const allActivity = (
    await pool.query('SELECT id, task_id, actor_id, action, created_at FROM task_activity ORDER BY created_at ASC')
  ).rows as { id: string; task_id: string; actor_id: string; action: string; created_at: Date }[]
  for (const a of allActivity) {
    await recordActivity(a.id, a.action, a.created_at.toISOString(), a.actor_id, 'Task', a.task_id)
  }
  console.log(`activity: synced ${allActivity.length} Activity nodes`)

  await pool.end()
  await closeDriver()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

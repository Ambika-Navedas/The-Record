import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from '../db.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sqlite = new DatabaseSync(path.join(__dirname, '..', '..', 'data.sqlite'))

const TABLES: { name: string; columns: string[] }[] = [
  { name: 'organizations', columns: ['id', 'name', 'domain'] },
  {
    name: 'users',
    columns: [
      'id', 'org_id', 'email', 'password_hash', 'name', 'initials', 'role', 'created_at',
      'designation', 'department', 'employee_id', 'avatar_path',
    ],
  },
  { name: 'sessions', columns: ['id', 'user_id', 'created_at', 'expires_at'] },
  {
    name: 'projects',
    columns: [
      'id', 'org_id', 'name', 'description', 'owner_id', 'status', 'git_url', 'deployment_url',
      'env_username', 'env_password', 'created_at', 'updated_at',
    ],
  },
  {
    name: 'meetings',
    columns: [
      'id', 'org_id', 'project_id', 'title', 'summary', 'participants', 'scheduled_at',
      'duration_min', 'sync_status', 'source', 'external_id', 'created_at',
    ],
  },
  {
    name: 'oauth_connections',
    columns: [
      'id', 'org_id', 'user_id', 'provider', 'access_token', 'refresh_token', 'expires_at',
      'connected_at', 'sync_query',
    ],
  },
  {
    name: 'meeting_assets',
    columns: [
      'id', 'meeting_id', 'org_id', 'filename', 'mime_type', 'size_bytes', 'storage_path',
      'uploaded_by', 'external_id', 'created_at',
    ],
  },
  {
    name: 'meeting_tasks',
    columns: [
      'id', 'meeting_id', 'org_id', 'title', 'assignee_id', 'due_date', 'done', 'created_at',
      'external_id', 'completion_note',
    ],
  },
  {
    name: 'task_activity',
    columns: ['id', 'org_id', 'task_id', 'actor_id', 'action', 'assignee_id', 'reason', 'created_at'],
  },
  { name: 'holidays', columns: ['id', 'org_id', 'date', 'name', 'is_optional', 'created_at'] },
  { name: 'holiday_selections', columns: ['id', 'org_id', 'user_id', 'holiday_id', 'created_at'] },
  { name: 'leave_types', columns: ['id', 'org_id', 'name'] },
  { name: 'leave_balances', columns: ['id', 'org_id', 'user_id', 'leave_type_id', 'balance'] },
  {
    name: 'leave_requests',
    columns: [
      'id', 'org_id', 'user_id', 'leave_type_id', 'from_date', 'to_date', 'days', 'reason',
      'status', 'reviewed_by', 'reviewed_at', 'created_at',
    ],
  },
  {
    name: 'knowledge_documents',
    columns: [
      'id', 'org_id', 'project_id', 'type', 'title', 'excerpt', 'owner_id', 'source_meeting_id',
      'keywords', 'view_count', 'external_id', 'storage_path', 'file_name', 'mime_type',
      'size_bytes', 'created_at', 'updated_at', 'deleted_at',
    ],
  },
]

async function copyTable(name: string, columns: string[]) {
  const rows = sqlite.prepare(`SELECT ${columns.join(', ')} FROM ${name}`).all() as Record<string, unknown>[]
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
  for (const row of rows) {
    const values = columns.map((c) => row[c])
    await pool.query(
      `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
      values,
    )
  }
  console.log(`${name}: copied ${rows.length} rows`)
}

async function main() {
  for (const t of TABLES) {
    await copyTable(t.name, t.columns)
  }

  console.log('\nRow-count parity check:')
  let allMatch = true
  for (const t of TABLES) {
    const sqliteCount = (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get() as { n: number }).n
    const neonCount = Number(
      (await pool.query(`SELECT COUNT(*)::int AS n FROM ${t.name}`)).rows[0].n,
    )
    const match = sqliteCount === neonCount
    if (!match) allMatch = false
    console.log(`  ${t.name}: sqlite=${sqliteCount} neon=${neonCount} ${match ? 'OK' : 'MISMATCH'}`)
  }
  console.log(allMatch ? '\nAll table row counts match.' : '\nMISMATCH — investigate before trusting the cutover.')

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

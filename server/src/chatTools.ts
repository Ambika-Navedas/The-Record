import type { FunctionDeclaration } from '@google/genai'
import { pool } from './db.ts'
import {
  expandRelatedDocuments,
  getPersonProjectInvolvement,
  getProjectActivitySince,
  getTaskAssignmentHistory,
} from './graph.ts'
import { keywordSearchDocuments } from './search.ts'

// The tool surface Ask The Record's LLM agent (chatAgent.ts) is allowed to use. Each tool is a
// narrow, parameterized query — never raw SQL/Cypher text from the model — so there's no
// injection surface: the model picks a function and structured arguments, this file is the only
// place that touches pool.query()/Cypher for chat. Deliberately excludes anything sensitive
// (oauth tokens, projects.env_password) even though those columns exist in the schema.

export const CHAT_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'find_members',
    description:
      'List org members (people with an account in The Record), optionally filtered by a name substring. Use for "who are the members/users/team", "who is X", "list people".',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        nameContains: { type: 'string', description: 'Optional substring to filter member names by.' },
      },
    },
  },
  {
    name: 'find_tasks',
    description:
      'Look up action items/tasks (with assignee, due date, done status) from meeting_tasks. Use for any question about tasks, due dates, deadlines, or who is assigned what. The row list is capped by `limit` (max 25) — the result always includes an exact `totalCount` regardless of how many rows are returned, so never infer a total from counting the returned list yourself. For "how many tasks in total" or "breakdown of tasks per person" questions, set groupByAssignee: true instead of counting rows — it returns an exact per-person count computed over ALL matching tasks, not just a page of them.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        assigneeName: { type: 'string', description: 'Filter to tasks assigned to a member whose name contains this.' },
        projectName: { type: 'string', description: "Filter to tasks whose meeting belongs to a project whose name contains this." },
        done: { type: 'boolean', description: 'Filter by completion status.' },
        orderBy: { type: 'string', enum: ['due_date_desc', 'due_date_asc', 'created_desc'], description: 'Sort order. Use due_date_desc for "latest/last due date" questions.' },
        limit: { type: 'number', description: 'Max rows to return, default 10.' },
        groupByAssignee: { type: 'boolean', description: 'Return an exact count of tasks per assignee instead of a row list. Use this for any "how many"/"total"/"breakdown by person" question about tasks.' },
      },
    },
  },
  {
    name: 'find_meetings',
    description: 'Look up meetings by title, participant, project, or date range, including a short summary excerpt.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        titleContains: { type: 'string' },
        participantName: { type: 'string' },
        projectName: { type: 'string' },
        fromDate: { type: 'string', description: 'ISO date, inclusive lower bound on scheduled_at.' },
        toDate: { type: 'string', description: 'ISO date, inclusive upper bound on scheduled_at.' },
        limit: { type: 'number', description: 'Max rows to return, default 5.' },
      },
    },
  },
  {
    name: 'find_projects',
    description: 'Look up projects by name or status, with owner and description. Never returns credentials.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        nameContains: { type: 'string' },
        status: { type: 'string', enum: ['on_track', 'attention', 'blocked'] },
      },
    },
  },
  {
    name: 'find_leave_balances',
    description: 'Look up leave balances (days remaining per leave type) for a member.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        memberName: { type: 'string', description: 'Filter to this member; omit to list all members.' },
      },
    },
  },
  {
    name: 'find_leave_requests',
    description: 'Look up leave requests (time off) with status, dates, and reason.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        memberName: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        limit: { type: 'number', description: 'Max rows to return, default 10.' },
      },
    },
  },
  {
    name: 'find_holidays',
    description: 'Look up company holidays by date range.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        fromDate: { type: 'string', description: 'ISO date, inclusive.' },
        toDate: { type: 'string', description: 'ISO date, inclusive.' },
        optionalOnly: { type: 'boolean' },
      },
    },
  },
  {
    name: 'search_documents',
    description:
      'Full-text keyword search over synced knowledge documents (mostly meeting-summary emails) for open-ended questions not covered by the other structured lookups ("what was discussed about X", "what were the action items from Y meeting").',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text, typically the user question itself.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'expand_related_documents',
    description:
      'Given document ids already found (e.g. from search_documents), find other documents connected via Neo4j Aura through a shared project, shared meeting, or shared meeting attendee. Use to broaden context once an initial document is found.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        documentIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['documentIds'],
    },
  },
  {
    name: 'get_task_assignment_history',
    description:
      'Look up the full assignment history of a task by title — who has been assigned to it over time, not just who has it now, using the temporal knowledge graph (each assignment is a time-bounded period, not a single overwritten value). Use for questions like "who was this assigned to before it was reassigned" or "who had this task on a given date" — questions find_tasks structurally cannot answer since it only ever sees the current assignee.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        taskTitle: { type: 'string', description: 'The task title, or a distinctive substring of it.' },
      },
      required: ['taskTitle'],
    },
  },
  {
    name: 'get_person_project_involvement',
    description:
      'Look up which projects a person has been involved in and since when, using the temporal knowledge graph (WORKED_ON relationships, derived from real project ownership and task-assignment activity). Use for "what projects has X worked on" or "what was X involved in during a period" — find_projects only lists a project\'s single current owner, not everyone who has touched it over time.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        personName: { type: 'string', description: "The member's name, or a distinctive substring of it." },
      },
      required: ['personName'],
    },
  },
  {
    name: 'get_project_change_history',
    description:
      'Look up what changed in a project over a time window — status changes, owner changes, and activity on its tasks — using the temporal knowledge graph. Use for "what changed in this project recently" or "what happened on this project in the last N days."',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        projectName: { type: 'string', description: 'The project name, or a distinctive substring of it.' },
        sinceDaysAgo: { type: 'number', description: 'How many days back to look. Defaults to 7 if not specified.' },
      },
      required: ['projectName'],
    },
  },
]

export interface ToolExecutionResult {
  result: unknown
  sourceDocIds?: string[]
  sourceVia?: 'keyword' | 'graph'
}

function likePattern(s: string): string {
  return `%${s}%`
}

async function findMembers(orgId: string, input: { nameContains?: string }): Promise<unknown> {
  const params: unknown[] = [orgId]
  let where = 'WHERE org_id = $1'
  if (input.nameContains) {
    params.push(likePattern(input.nameContains))
    where += ` AND name ILIKE $${params.length}`
  }
  const { rows } = await pool.query(
    `SELECT name, role, designation, department, employee_id AS "employeeId" FROM users ${where} ORDER BY name`,
    params,
  )
  return rows
}

async function findTasks(
  orgId: string,
  input: { assigneeName?: string; projectName?: string; done?: boolean; orderBy?: string; limit?: number; groupByAssignee?: boolean },
): Promise<unknown> {
  const params: unknown[] = [orgId]
  let where = 'WHERE mt.org_id = $1'
  if (input.assigneeName) {
    params.push(likePattern(input.assigneeName))
    where += ` AND u.name ILIKE $${params.length}`
  }
  if (input.projectName) {
    params.push(likePattern(input.projectName))
    where += ` AND p.name ILIKE $${params.length}`
  }
  if (typeof input.done === 'boolean') {
    params.push(input.done ? 1 : 0)
    where += ` AND mt.done = $${params.length}`
  }

  const fromJoins = `FROM meeting_tasks mt
     JOIN meetings m ON m.id = mt.meeting_id
     LEFT JOIN users u ON u.id = mt.assignee_id
     LEFT JOIN projects p ON p.id = m.project_id`

  // "How many tasks / breakdown by person" questions need an exact aggregate, not the model
  // trying to count a row list that's capped by `limit` below — that's exactly the bug this
  // mode exists to avoid: an earlier version only had find_tasks return a limited row list, and
  // the model mistook a 25-row page for the true total when asked for a count. GROUP BY here
  // runs over every matching row, no LIMIT, so the counts are always exact regardless of how
  // many tasks actually exist.
  if (input.groupByAssignee) {
    const { rows: totalRows } = await pool.query(`SELECT COUNT(*)::int AS count ${fromJoins} ${where}`, params)
    const { rows: grouped } = await pool.query(
      `SELECT COALESCE(u.name, '(unassigned)') AS assignee, COUNT(*)::int AS count
       ${fromJoins}
       ${where}
       GROUP BY u.name
       ORDER BY count DESC, assignee`,
      params,
    )
    return { totalCount: (totalRows[0] as { count: number }).count, byAssignee: grouped }
  }

  const orderBy =
    input.orderBy === 'due_date_asc'
      ? 'mt.due_date ASC NULLS LAST'
      : input.orderBy === 'created_desc'
        ? 'mt.created_at DESC'
        : 'mt.due_date DESC NULLS LAST'
  const limit = Math.min(input.limit ?? 10, 25)

  const { rows: totalRows } = await pool.query(`SELECT COUNT(*)::int AS count ${fromJoins} ${where}`, params)
  const { rows } = await pool.query(
    `SELECT mt.title, mt.due_date AS "dueDate", mt.done, u.name AS assignee, m.title AS "meetingTitle", p.name AS "projectName"
     ${fromJoins}
     ${where}
     ORDER BY ${orderBy}
     LIMIT ${limit}`,
    params,
  )
  return {
    totalCount: (totalRows[0] as { count: number }).count,
    tasks: rows,
    note: (totalRows[0] as { count: number }).count > rows.length ? `Showing ${rows.length} of ${(totalRows[0] as { count: number }).count} total — this list is not complete.` : undefined,
  }
}

async function findMeetings(
  orgId: string,
  input: { titleContains?: string; participantName?: string; projectName?: string; fromDate?: string; toDate?: string; limit?: number },
): Promise<unknown> {
  const params: unknown[] = [orgId]
  let where = 'WHERE m.org_id = $1'
  if (input.titleContains) {
    params.push(likePattern(input.titleContains))
    where += ` AND m.title ILIKE $${params.length}`
  }
  if (input.projectName) {
    params.push(likePattern(input.projectName))
    where += ` AND p.name ILIKE $${params.length}`
  }
  if (input.fromDate) {
    params.push(input.fromDate)
    where += ` AND m.scheduled_at >= $${params.length}`
  }
  if (input.toDate) {
    params.push(input.toDate)
    where += ` AND m.scheduled_at <= $${params.length}`
  }
  const limit = Math.min(input.limit ?? 5, 20)
  const { rows } = await pool.query(
    `SELECT m.title, m.scheduled_at AS "scheduledAt", m.participants, p.name AS "projectName", LEFT(m.summary, 400) AS "summaryExcerpt"
     FROM meetings m
     LEFT JOIN projects p ON p.id = m.project_id
     ${where}
     ORDER BY m.scheduled_at DESC
     LIMIT ${limit}`,
    params,
  )

  let filtered = rows as { participants: string }[]
  if (input.participantName) {
    const userRes = await pool.query('SELECT id, name FROM users WHERE org_id = $1 AND name ILIKE $2', [
      orgId,
      likePattern(input.participantName),
    ])
    const matchedIds = new Set((userRes.rows as { id: string }[]).map((u) => u.id))
    filtered = filtered.filter((r) => {
      const parsed = JSON.parse(r.participants) as unknown[]
      return parsed.some((entry) => {
        const userId = typeof entry === 'string' ? entry : (entry as { userId: string | null }).userId
        return userId && matchedIds.has(userId)
      })
    })
  }
  return filtered.map((r) => ({ ...r, participants: undefined }))
}

async function findProjects(orgId: string, input: { nameContains?: string; status?: string }): Promise<unknown> {
  const params: unknown[] = [orgId]
  let where = 'WHERE pr.org_id = $1'
  if (input.nameContains) {
    params.push(likePattern(input.nameContains))
    where += ` AND pr.name ILIKE $${params.length}`
  }
  if (input.status) {
    params.push(input.status)
    where += ` AND pr.status = $${params.length}`
  }
  const { rows } = await pool.query(
    `SELECT pr.name, pr.description, pr.status, u.name AS owner
     FROM projects pr
     JOIN users u ON u.id = pr.owner_id
     ${where}
     ORDER BY pr.name`,
    params,
  )
  return rows
}

async function findLeaveBalances(orgId: string, input: { memberName?: string }): Promise<unknown> {
  const params: unknown[] = [orgId]
  let where = 'WHERE u.org_id = $1'
  if (input.memberName) {
    params.push(likePattern(input.memberName))
    where += ` AND u.name ILIKE $${params.length}`
  }
  const { rows } = await pool.query(
    `SELECT u.name AS member, lt.name AS "leaveType", lb.balance
     FROM leave_balances lb
     JOIN users u ON u.id = lb.user_id
     JOIN leave_types lt ON lt.id = lb.leave_type_id
     ${where}
     ORDER BY u.name, lt.name`,
    params,
  )
  return rows
}

async function findLeaveRequests(
  orgId: string,
  input: { memberName?: string; status?: string; limit?: number },
): Promise<unknown> {
  const params: unknown[] = [orgId]
  let where = 'WHERE u.org_id = $1'
  if (input.memberName) {
    params.push(likePattern(input.memberName))
    where += ` AND u.name ILIKE $${params.length}`
  }
  if (input.status) {
    params.push(input.status)
    where += ` AND lr.status = $${params.length}`
  }
  const limit = Math.min(input.limit ?? 10, 25)
  const { rows } = await pool.query(
    `SELECT u.name AS member, lt.name AS "leaveType", lr.from_date AS "fromDate", lr.to_date AS "toDate",
            lr.days, lr.status, lr.reason
     FROM leave_requests lr
     JOIN users u ON u.id = lr.user_id
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     ${where}
     ORDER BY lr.from_date DESC
     LIMIT ${limit}`,
    params,
  )
  return rows
}

// The temporal-graph tool: resolves a task by title in Postgres (the graph doesn't do fuzzy text
// search), then asks the graph for its full time-bounded assignment history — the one query
// shape this app's graph can answer that a plain "current assignee_id column" structurally can't.
async function getTaskHistory(orgId: string, input: { taskTitle?: string }): Promise<unknown> {
  if (!input.taskTitle) return { error: 'taskTitle is required' }
  const { rows: matches } = await pool.query(
    'SELECT id, title FROM meeting_tasks WHERE org_id = $1 AND title ILIKE $2 ORDER BY created_at DESC LIMIT 5',
    [orgId, likePattern(input.taskTitle)],
  )
  if (matches.length === 0) return { error: `No task found matching "${input.taskTitle}".` }
  if (matches.length > 1) {
    return {
      ambiguous: true,
      candidates: (matches as { id: string; title: string }[]).map((m) => m.title),
      note: 'More than one task matches — ask which one, or call again with a more specific title.',
    }
  }

  const task = matches[0] as { id: string; title: string }
  const history = await getTaskAssignmentHistory(task.id)
  if (history.length === 0) return { title: task.title, history: [], note: 'No assignment history found for this task.' }

  const personIds = [...new Set(history.map((h) => h.personId))]
  const { rows: people } = await pool.query('SELECT id, name FROM users WHERE id = ANY($1)', [personIds])
  const nameById = new Map((people as { id: string; name: string }[]).map((p) => [p.id, p.name]))

  return {
    title: task.title,
    history: history.map((h) => ({
      assignee: nameById.get(h.personId) ?? 'Unknown',
      validFrom: h.validFrom,
      validTo: h.validTo ?? 'present (current assignee)',
    })),
  }
}

async function getPersonInvolvement(orgId: string, input: { personName?: string }): Promise<unknown> {
  if (!input.personName) return { error: 'personName is required' }
  const { rows: matches } = await pool.query('SELECT id, name FROM users WHERE org_id = $1 AND name ILIKE $2', [
    orgId,
    likePattern(input.personName),
  ])
  if (matches.length === 0) return { error: `No member found matching "${input.personName}".` }
  if (matches.length > 1) {
    return {
      ambiguous: true,
      candidates: (matches as { id: string; name: string }[]).map((m) => m.name),
      note: 'More than one member matches — ask which one, or call again with a more specific name.',
    }
  }

  const person = matches[0] as { id: string; name: string }
  const involvement = await getPersonProjectInvolvement(person.id)
  if (involvement.length === 0) {
    return { name: person.name, involvement: [], note: 'No project involvement recorded in the graph yet.' }
  }
  return {
    name: person.name,
    involvement: involvement.map((i) => ({
      project: i.projectName,
      validFrom: i.validFrom,
      lastActive: i.validTo,
    })),
  }
}

async function getProjectChanges(orgId: string, input: { projectName?: string; sinceDaysAgo?: number }): Promise<unknown> {
  if (!input.projectName) return { error: 'projectName is required' }
  const { rows: matches } = await pool.query('SELECT id, name FROM projects WHERE org_id = $1 AND name ILIKE $2', [
    orgId,
    likePattern(input.projectName),
  ])
  if (matches.length === 0) return { error: `No project found matching "${input.projectName}".` }
  if (matches.length > 1) {
    return {
      ambiguous: true,
      candidates: (matches as { id: string; name: string }[]).map((m) => m.name),
      note: 'More than one project matches — ask which one, or call again with a more specific name.',
    }
  }

  const project = matches[0] as { id: string; name: string }
  const sinceDays = input.sinceDaysAgo ?? 7
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
  const activity = await getProjectActivitySince(project.id, since)
  if (activity.length === 0) {
    return { project: project.name, sinceDaysAgo: sinceDays, activity: [], note: 'No recorded activity in this window.' }
  }
  return { project: project.name, sinceDaysAgo: sinceDays, activity }
}

async function findHolidays(orgId: string, input: { fromDate?: string; toDate?: string; optionalOnly?: boolean }): Promise<unknown> {
  const params: unknown[] = [orgId]
  let where = 'WHERE org_id = $1'
  if (input.fromDate) {
    params.push(input.fromDate)
    where += ` AND date >= $${params.length}`
  }
  if (input.toDate) {
    params.push(input.toDate)
    where += ` AND date <= $${params.length}`
  }
  if (input.optionalOnly) {
    where += ' AND is_optional = 1'
  }
  const { rows } = await pool.query(
    `SELECT date, name, is_optional AS "isOptional" FROM holidays ${where} ORDER BY date`,
    params,
  )
  return rows
}

export async function executeTool(orgId: string, name: string, input: Record<string, unknown>): Promise<ToolExecutionResult> {
  switch (name) {
    case 'find_members':
      return { result: await findMembers(orgId, input) }
    case 'find_tasks':
      return { result: await findTasks(orgId, input) }
    case 'find_meetings':
      return { result: await findMeetings(orgId, input) }
    case 'find_projects':
      return { result: await findProjects(orgId, input) }
    case 'find_leave_balances':
      return { result: await findLeaveBalances(orgId, input) }
    case 'find_leave_requests':
      return { result: await findLeaveRequests(orgId, input) }
    case 'find_holidays':
      return { result: await findHolidays(orgId, input) }
    case 'get_task_assignment_history':
      return { result: await getTaskHistory(orgId, input) }
    case 'get_person_project_involvement':
      return { result: await getPersonInvolvement(orgId, input) }
    case 'get_project_change_history':
      return { result: await getProjectChanges(orgId, input) }
    case 'search_documents': {
      const docs = await keywordSearchDocuments(orgId, input.query as string, 3)
      return {
        result: docs.map((d) => ({ id: d.doc.id, title: d.doc.title, type: d.doc.type, project: d.projectName, excerpt: d.snippet })),
        sourceDocIds: docs.map((d) => d.doc.id),
        sourceVia: 'keyword',
      }
    }
    case 'expand_related_documents': {
      const ids = await expandRelatedDocuments(input.documentIds as string[], 3)
      if (ids.length === 0) return { result: [] }
      const { rows } = await pool.query(
        `SELECT kd.id, kd.title, kd.type, p.name AS project
         FROM knowledge_documents kd
         LEFT JOIN projects p ON p.id = kd.project_id
         WHERE kd.id = ANY($1)`,
        [ids],
      )
      return { result: rows, sourceDocIds: ids, sourceVia: 'graph' }
    }
    default:
      return { result: { error: `unknown tool: ${name}` } }
  }
}

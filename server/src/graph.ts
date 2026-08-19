import neo4j, { type Driver } from 'neo4j-driver'

// Lazy singleton, not created at module top-level — same reasoning as integrations.ts's
// config() functions: ES module imports are hoisted and evaluated before index.ts's own
// .env-loading line runs (see db.ts's comment for the full explanation), so reading
// process.env.NEO4J_* at module-evaluation time could see empty strings. Reading inside a
// function, on first real use, sidesteps the whole ordering question.
let driver: Driver | null | undefined // undefined = not yet attempted, null = attempted and unconfigured

function getDriver(): Driver | null {
  if (driver !== undefined) return driver
  const uri = process.env.NEO4J_URI
  const username = process.env.NEO4J_USERNAME
  const password = process.env.NEO4J_PASSWORD
  driver = uri && username && password ? neo4j.driver(uri, neo4j.auth.basic(username, password)) : null
  return driver
}

// The long-running Express server never calls this — the driver is meant to stay open for its
// whole lifetime there. One-off scripts (backfill-*.ts) must call it before exiting, though: the
// driver's connection pool keeps its own event-loop handles open, so without this the process
// hangs indefinitely after finishing its real work instead of exiting — the exact "backfill
// appears to hang forever" symptom hit more than once in this project before this existed.
export async function closeDriver() {
  if (driver) await driver.close()
}

// Graph sync is best-effort and additive — Ask The Record's existing keyword search (search.ts)
// works identically with or without it. A Neo4j hiccup, or it simply not being configured, must
// never break the Postgres write it's mirroring or the answer it's meant to enhance, so every
// call here swallows its own errors rather than throwing.
async function graphWrite(cypher: string, params: Record<string, unknown> = {}) {
  const d = getDriver()
  if (!d) return
  const session = d.session()
  try {
    await session.run(cypher, params)
  } catch (err) {
    console.error('Neo4j write failed', err)
  } finally {
    await session.close()
  }
}

async function graphRead<T = Record<string, unknown>>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const d = getDriver()
  if (!d) return []
  const session = d.session()
  try {
    const result = await session.run(cypher, params)
    return result.records.map((r) => r.toObject() as T)
  } catch (err) {
    console.error('Neo4j read failed', err)
    return []
  } finally {
    await session.close()
  }
}

// --- Schema-specific helpers ---
//
// Nodes: Project {id, name}, Meeting {id, title}, Document {id, title, type}, Person {id}.
// Edges: (Meeting|Document)-[:IN_PROJECT]->(Project), (Document)-[:FROM_MEETING]->(Meeting),
// (Meeting)-[:ATTENDED_BY]->(Person). All one-directional and set once — nothing in this app
// lets a meeting's or document's project/meeting link change after creation (no PATCH exposes
// those fields), so these are plain upserts with no "remove the old edge first" logic needed.

export async function upsertProject(id: string, name: string) {
  await graphWrite('MERGE (p:Project {id: $id}) SET p.name = $name', { id, name })
}

export async function upsertMeeting(id: string, title: string, projectId: string | null) {
  await graphWrite('MERGE (m:Meeting {id: $id}) SET m.title = $title', { id, title })
  if (projectId) {
    await graphWrite(
      'MATCH (m:Meeting {id: $id}) MERGE (p:Project {id: $projectId}) MERGE (m)-[:IN_PROJECT]->(p)',
      { id, projectId },
    )
  }
}

export async function attendMeeting(meetingId: string, personId: string) {
  await graphWrite(
    'MATCH (m:Meeting {id: $meetingId}) MERGE (person:Person {id: $personId}) MERGE (m)-[:ATTENDED_BY]->(person)',
    { meetingId, personId },
  )
}

export async function upsertDocument(
  id: string,
  title: string,
  type: string,
  projectId: string | null,
  meetingId: string | null,
) {
  await graphWrite('MERGE (d:Document {id: $id}) SET d.title = $title, d.type = $type', { id, title, type })
  if (projectId) {
    await graphWrite(
      'MATCH (d:Document {id: $id}) MERGE (p:Project {id: $projectId}) MERGE (d)-[:IN_PROJECT]->(p)',
      { id, projectId },
    )
  }
  if (meetingId) {
    await graphWrite(
      'MATCH (d:Document {id: $id}) MERGE (m:Meeting {id: $meetingId}) MERGE (d)-[:FROM_MEETING]->(m)',
      { id, meetingId },
    )
  }
}

export async function linkDocumentToMeeting(documentId: string, meetingId: string) {
  await graphWrite(
    'MATCH (d:Document {id: $documentId}) MATCH (m:Meeting {id: $meetingId}) MERGE (d)-[:FROM_MEETING]->(m)',
    { documentId, meetingId },
  )
}

// --- Temporal knowledge graph ---
//
// Everything above is a plain (non-temporal) graph: every edge is written with MERGE and treated
// as permanently true once created — there's no "this was true from date A to date B." Everything
// below adds time: instead of overwriting a fact, each state gets its own time-bounded edge, so a
// query can ask "what was true on date X," not just "what's true now."
//
// Naming: valid_from / valid_to on every temporal edge (renamed from an earlier from/until
// prototype — see the ask-the-record backend.md changelog for that migration). NULL valid_to
// means "still current" — an open-ended interval, not an unknown one.
//
// Scoped to the relationships this app has *real* data for. Two from the original design brief
// were deliberately left out because nothing in this codebase produces the source data for them
// yet — Task-DEPENDS_ON-Task (no task-dependency concept exists in Postgres) and CalendarEvent
// (no calendar_events table — "calendar views" are computed on the fly from due dates and leave
// requests, not stored). Building either now would mean inventing data, not modeling it.

export async function upsertTask(id: string, title: string, meetingId: string | null) {
  await graphWrite('MERGE (t:Task {id: $id}) SET t.title = $title', { id, title })
  if (meetingId) {
    await graphWrite(
      'MATCH (t:Task {id: $id}) MERGE (m:Meeting {id: $meetingId}) MERGE (t)-[:FROM_MEETING]->(m)',
      { id, meetingId },
    )
  }
}

// A task's project affiliation is never stored directly (see backend.md's schema-analysis note) —
// it's always derived one hop through the task's meeting. Called whenever that meeting's project
// is known, so PART_OF stays in sync without needing its own write path.
export async function linkTaskToProject(taskId: string, projectId: string) {
  await graphWrite(
    'MATCH (t:Task {id: $taskId}) MERGE (p:Project {id: $projectId}) MERGE (t)-[:PART_OF]->(p)',
    { taskId, projectId },
  )
}

// Closes whatever assignment period is currently open on a task (a no-op if it was never assigned
// before — the MATCH simply finds nothing). Only the backfill script can look ahead at a task's
// complete history to know a period's valid_to in one pass; a live write, at the moment a
// reassignment happens, only knows "this one just ended" — so a real reassignment is always two
// writes: close the open one, then recordTaskAssignment() the new one with valid_to left null.
export async function closeOpenTaskAssignment(taskId: string, at: string) {
  await graphWrite(
    `MATCH (t:Task {id: $taskId})-[r:ASSIGNED_TO]->(:Person)
     WHERE r.valid_to IS NULL
     SET r.valid_to = datetime($at)`,
    { taskId, at },
  )
}

export async function recordTaskAssignment(taskId: string, personId: string, validFrom: string, validTo: string | null) {
  await graphWrite(
    `MATCH (t:Task {id: $taskId})
     MERGE (p:Person {id: $personId})
     MERGE (t)-[r:ASSIGNED_TO {valid_from: datetime($validFrom)}]->(p)
     SET r.valid_to = CASE WHEN $validTo IS NULL THEN NULL ELSE datetime($validTo) END`,
    { taskId, personId, validFrom, validTo },
  )
}

export interface AssignmentPeriod {
  personId: string
  validFrom: string
  validTo: string | null
}

// Full history, ordered oldest-first — the point of a temporal graph over just "current state" is
// that this can answer "who had it before," not just "who has it now."
export async function getTaskAssignmentHistory(taskId: string): Promise<AssignmentPeriod[]> {
  return graphRead<AssignmentPeriod>(
    `MATCH (t:Task {id: $taskId})-[r:ASSIGNED_TO]->(p:Person)
     RETURN p.id AS personId, toString(r.valid_from) AS validFrom,
            CASE WHEN r.valid_to IS NULL THEN NULL ELSE toString(r.valid_to) END AS validTo
     ORDER BY r.valid_from ASC`,
    { taskId },
  )
}

// Point-in-time lookup — the query shape a temporal graph makes natural and a plain "current
// state only" graph structurally cannot answer at all.
export async function getTaskAssigneeAsOf(taskId: string, asOf: string): Promise<string | null> {
  const rows = await graphRead<{ personId: string }>(
    `MATCH (t:Task {id: $taskId})-[r:ASSIGNED_TO]->(p:Person)
     WHERE r.valid_from <= datetime($asOf) AND (r.valid_to IS NULL OR r.valid_to > datetime($asOf))
     RETURN p.id AS personId
     LIMIT 1`,
    { taskId, asOf },
  )
  return rows[0]?.personId ?? null
}

// Person-WORKED_ON-Project: no project-membership table exists (see backend.md) — this is derived
// from real observed activity instead of new membership CRUD. valid_from is the first time this
// person was ever seen active on this project (an assigned task, or attending a project meeting);
// valid_to keeps extending forward on every later observation. Not "closed" by anyone else's
// involvement, unlike ASSIGNED_TO — many people can simultaneously be working on one project, so
// there's no single successor edge to hand the interval off to.
export async function recordProjectInvolvement(personId: string, projectId: string, at: string) {
  await graphWrite(
    `MATCH (proj:Project {id: $projectId})
     MERGE (person:Person {id: $personId})
     MERGE (person)-[r:WORKED_ON]->(proj)
     ON CREATE SET r.valid_from = datetime($at), r.valid_to = datetime($at)
     ON MATCH SET r.valid_to = CASE WHEN datetime($at) > r.valid_to THEN datetime($at) ELSE r.valid_to END`,
    { personId, projectId, at },
  )
}

export interface ProjectInvolvement {
  projectId: string
  projectName: string
  validFrom: string
  validTo: string
}

export async function getPersonProjectInvolvement(personId: string): Promise<ProjectInvolvement[]> {
  return graphRead<ProjectInvolvement>(
    `MATCH (person:Person {id: $personId})-[r:WORKED_ON]->(proj:Project)
     RETURN proj.id AS projectId, proj.name AS projectName,
            toString(r.valid_from) AS validFrom, toString(r.valid_to) AS validTo
     ORDER BY r.valid_from ASC`,
    { personId },
  )
}

// Activity: a first-class event node, not just an edge property — one per real event (task
// assigned/done/reopened, project status/owner changed). occurred_at is a point in time, not an
// interval, since an event doesn't have a "valid_to": it happened once. actorId is who performed
// it; relatedType/relatedId is what it happened to (a Task or a Project — the two entity types
// this app actually logs events against today).
export async function recordActivity(
  id: string,
  kind: string,
  occurredAt: string,
  actorId: string,
  relatedType: 'Task' | 'Project',
  relatedId: string,
) {
  await graphWrite(
    `MERGE (a:Activity {id: $id})
     SET a.kind = $kind, a.occurred_at = datetime($occurredAt)
     MERGE (person:Person {id: $actorId})
     MERGE (person)-[:PERFORMED]->(a)
     MERGE (rel:${relatedType} {id: $relatedId})
     MERGE (a)-[:RELATED_TO]->(rel)`,
    { id, kind, occurredAt, actorId, relatedId },
  )
}

export interface ActivityEntry {
  id: string
  kind: string
  occurredAt: string
}

// "What changed in this project during the last N days" — Activity related directly to the
// project (status/owner changes) unioned with Activity related to any task PART_OF the project
// (task-level events), which plain SQL would need two separate queries plus an in-app merge for.
export async function getProjectActivitySince(projectId: string, sinceIso: string): Promise<ActivityEntry[]> {
  return graphRead<ActivityEntry>(
    `MATCH (a:Activity)-[:RELATED_TO]->(proj:Project {id: $projectId})
     WHERE a.occurred_at >= datetime($sinceIso)
     RETURN a.id AS id, a.kind AS kind, toString(a.occurred_at) AS occurredAt
     UNION
     MATCH (a:Activity)-[:RELATED_TO]->(:Task)-[:PART_OF]->(proj:Project {id: $projectId})
     WHERE a.occurred_at >= datetime($sinceIso)
     RETURN a.id AS id, a.kind AS kind, toString(a.occurred_at) AS occurredAt
     ORDER BY occurredAt DESC`,
    { projectId, sinceIso },
  )
}

// Given a set of documents that already scored well on keyword search (search.ts), finds
// others connected to them by shared project, shared meeting, or a meeting attended by the
// same person as one of the seeds' meetings — content the keyword scorer alone would never
// surface, since it never looks at these relationships at all. `limit` is always an internal
// constant (never user input), so it's templated directly rather than bound as a param.
export async function expandRelatedDocuments(seedIds: string[], limit: number): Promise<string[]> {
  if (seedIds.length === 0) return []
  const rows = await graphRead<{ id: string }>(
    `MATCH (seed:Document)-[:IN_PROJECT]->(:Project)<-[:IN_PROJECT]-(related:Document)
     WHERE seed.id IN $seedIds AND NOT related.id IN $seedIds
     RETURN DISTINCT related.id AS id
     UNION
     MATCH (seed:Document)-[:FROM_MEETING]->(:Meeting)<-[:FROM_MEETING]-(related:Document)
     WHERE seed.id IN $seedIds AND NOT related.id IN $seedIds
     RETURN DISTINCT related.id AS id
     UNION
     MATCH (seed:Document)-[:FROM_MEETING]->(:Meeting)-[:ATTENDED_BY]->(:Person)<-[:ATTENDED_BY]-(:Meeting)<-[:FROM_MEETING]-(related:Document)
     WHERE seed.id IN $seedIds AND NOT related.id IN $seedIds
     RETURN DISTINCT related.id AS id
     LIMIT ${Math.max(0, Math.floor(limit))}`,
    { seedIds },
  )
  return rows.map((r) => r.id)
}

# Ask The Record (Chat) — Backend

**Status: built.** Real LLM-backed question answering (not the old pure-retrieval design — see "LLM agent architecture" below). Lives in `server/src/chatAgent.ts` (the agent loop) + `server/src/chatTools.ts` (the tool surface it can call) + `server/src/search.ts` (keyword search, now just one tool among several) + `server/src/routes/chat.ts` (endpoint).

## Query logging — removed
Chat queries are **no longer persisted anywhere**. There used to be a `chat_queries` table (question, answer_text, matched_document_ids) that every `POST /api/chat/ask` call wrote a row to — that's gone, per direct request: fetch the answer from the DB and show it, but don't save the query/answer itself. Specifically:
- `server/src/routes/chat.ts` no longer does an `INSERT INTO chat_queries` after computing an answer.
- `server/src/db.ts` no longer creates the `chat_queries` table, and runs a one-time `DROP TABLE IF EXISTS chat_queries` on startup to clean up any existing DB file that still had it from before this change.
- `server/src/seed.ts` no longer references `chat_queries` in its cleanup step.

The dashboard's "Questions answered" card, which was computed entirely from this table, was removed as a direct consequence — see `dashboard/backend.md` and `dashboard/design.md`.

## Endpoint

`POST /api/chat/ask` (requireAuth) — `{ question: string }` → `{ answerText: string, sources: { id, title, type, project, via }[] }`. `via` (`'keyword' | 'graph'`) added alongside the Neo4j graph-expansion feature below — mostly a read — see "Popularity counter" below for the one write it does perform.

## Popularity counter (added later — a deliberately different kind of write than the removed query log)
After computing the answer, the handler loops over the cited `sourceDocs` and runs `UPDATE knowledge_documents SET view_count = view_count + 1 WHERE id = ?` for each one. This exists to power the Dashboard's "Most popular content" card (see `dashboard/backend.md`).

This is intentionally **not** a reintroduction of the removed `chat_queries` log: no question text, no answer text, no user identity, no timestamp, no per-query row at all — just a running integer on the document itself, incremented in place. When asked how "most popular" should be determined given that chat logging had just been removed per explicit request, this was the option chosen specifically because it doesn't store *what was asked* or *by whom*, only a bare count of *how often this document has been useful*.

## LLM agent architecture (as built — replaces pure keyword retrieval)
The original design (kept below, in "Superseded: keyword-only retrieval," for history) was deliberately non-generative: TF-IDF keyword scoring over synced documents, with the top-scoring paragraph returned verbatim as "the answer." That worked for open-ended "what was discussed" questions but had no way to answer anything requiring a real lookup — "what was the last due date for Deepika's task" or "who are the members" both just returned whatever document happened to share the most keywords, regardless of whether it actually contained the answer. Two narrow regex-based patches (`taskSearch.ts`, `memberSearch.ts`) were added first to special-case those two question types, then removed once it was clear that approach doesn't generalize — every new question phrasing or topic would need its own hand-written intent detector forever.

**Replaced with a real LLM tool-use agent** (`server/src/chatAgent.ts`, `server/src/chatTools.ts`): the model reads the question, decides which of 12 tools to call (with what arguments), the server executes them against Postgres/Neo4j, feeds the real results back, and the model writes the final answer grounded in that data — the same pattern this agent itself is built with (tool-calling loop, not free-form generation).

**Provider**: Google Gemini (`@google/genai`), model `gemini-3.6-flash`. Originally built against Anthropic's Claude API (`@anthropic-ai/sdk`) — swapped out per direct request before ever going live (the Anthropic key hit `credit balance too low` on first real test, and the org switched providers rather than fund it). The swap only touched `chatAgent.ts` (the SDK-specific call/loop code) and `chatTools.ts`'s schema wrapper (Anthropic's `input_schema` field renamed to Gemini's `parametersJsonSchema` — the actual JSON Schema bodies underneath didn't need to change, both accept plain lowercase-`type` JSON Schema). `chatTools.ts`'s `executeTool()` — the actual data-access layer — is fully provider-agnostic and wasn't touched at all.
- Model id resolution: `gemini-2.5-flash` (the id known at build time) returned a live `404` — *"This model ... is no longer available to new users. Please update your code to use models/gemini-3.6-flash"* — so the real API error was used to pick the current id rather than guessing.
- `GEMINI_API_KEY` in `.env`/`.env.example`, from https://aistudio.google.com/apikey. No degrade-to-no-op path here (unlike Zoom/Google/Neo4j) — chat has no meaningful fallback without an LLM, so a missing/invalid key means `POST /api/chat/ask` errors outright rather than silently returning something worse.

**Tool surface** (`chatTools.ts`'s `CHAT_TOOL_DECLARATIONS` + `executeTool()`) — 12 tools, each a narrow parameterized query, never raw SQL/Cypher text from the model (the model picks a function name + structured arguments only; `executeTool()`'s `switch` is the only place that touches `pool.query()`/Cypher for chat, so there's no injection surface regardless of what the model is told to do):
| Tool | Backs |
|---|---|
| `find_members` | `users` — "who are the members/users/team" |
| `find_tasks` | `meeting_tasks` joined `meetings`/`users`/`projects` — due dates, assignees, done status |
| `find_meetings` | `meetings` joined `projects`, filtered by participant via `users` | 
| `find_projects` | `projects` joined `users` (owner) — deliberately excludes `env_username`/`env_password`, even though those columns exist on the table |
| `find_leave_balances` | `leave_balances` joined `users`/`leave_types` |
| `find_leave_requests` | `leave_requests` joined `users`/`leave_types` |
| `find_holidays` | `holidays` |
| `search_documents` | wraps `keywordSearchDocuments()` (the surviving piece of the old TF-IDF engine, see below) — for open-ended questions the structured tools above can't answer |
| `expand_related_documents` | wraps `graph.ts`'s `expandRelatedDocuments()` — Neo4j Aura graph expansion, now agent-invoked instead of automatic (see "Graph-expanded retrieval" below) |
| `get_task_assignment_history` | wraps `graph.ts`'s temporal `ASSIGNED_TO` edges — see "Temporal knowledge graph" below |
| `get_person_project_involvement` | wraps `graph.ts`'s temporal `WORKED_ON` edges |
| `get_project_change_history` | wraps `graph.ts`'s `Activity`/`PERFORMED`/`RELATED_TO` nodes and edges |

**Loop** (`answerQuestionWithAgent()` in `chatAgent.ts`): a Gemini `chats.create()` session with all 12 tools attached and a system prompt (org name, today's date, instructions to always use tools rather than guess, prefer structured tools over `search_documents`, admit when nothing is found, ask for clarification on an ambiguous name). `sendMessage()` in a loop up to `MAX_TOOL_ROUNDS = 4`: while the response carries `functionCalls`, execute each via `executeTool()` and send the results back as `functionResponse` parts; once the response has no more function calls, its `.text` is the final answer. If the round budget runs out with the model still calling tools, one guaranteed final `sendMessage()` fires with `config: { tools: [] }` — no tools available forces a plain-text answer from whatever was already gathered, rather than the loop just giving up (see "Bug found" below for why this exists). Any document ids surfaced by `search_documents`/`expand_related_documents` during the loop are tracked in a `Map<id, 'keyword'|'graph'>` and resolved to the `sources` shape the frontend already expects (see `frontend.md`) at the end — so structured-data answers (tasks, members, leave, etc.) return `sources: []`, exactly like the old regex intercepts did, while document-grounded answers still cite real sources with the same `via` labeling as before.

## Superseded: keyword-only retrieval (`search.ts`, kept as the `search_documents` tool)
The original non-generative design, now reduced to one tool the agent can call rather than the whole answer pipeline. `keywordSearchDocuments(orgId, query, topK)`:
1. Loads every `knowledge_documents` row for the org (joined with `projects` for the project name), rebuilding the corpus **on every call** — no caching/index. Would need real caching or a move to Postgres full-text search / a dedicated search engine before corpus size matters — still not needed at 25-doc scale.
2. Tokenizes (`title + excerpt + project name + keywords`), strips a small stopword list.
3. Computes document frequency per term, then a lightweight IDF weight (`log((N+1)/(df+1)) + 1`).
4. Scores each doc by summed `tf * idf` over the query's terms, returns docs scoring at or above `MIN_ANSWER_SCORE` (2) — see "Bug found + fixed" below for why this replaced a plain `score > 0` filter.
5. Extracts a focused **passage** from each matched doc via `extractAnswerSnippet()` — not the whole `excerpt` verbatim, see below — and returns it as the tool result for the LLM to read and summarize, rather than returning it directly as "the answer" the way the old pipeline did.

This started as a straight, faithful port of the client-side engine that used to live in `src/lib/search.ts` (now deleted from the frontend) — same tokenizer, same TF-IDF-lite scoring, just running server-side over the real DB instead of a hardcoded array.

## Graph-expanded retrieval via Neo4j Aura (as built)
Direct request, after an unrelated exploratory question ("I want to connect my neon db to neo4j aura") was answered honestly (real pros/cons, including "nothing in this app currently needs graph traversal") — the follow-up made it concrete: "I want the feature for ask the record." Scoped with three direct answers before building: sync-on-write (not a manual "Sync now" button — every relevant Postgres write also writes to the graph in the same request), "expand results via relationships" (not a visual graph explorer), and the user had real Aura credentials ready.

**What it adds, concretely:** the agent can call `expand_related_documents` (typically after `search_documents`) to find other documents connected to already-found ones by a **shared project**, a **shared source meeting**, or a **meeting attended by the same person as one of the matched documents' meetings** — content keyword scoring structurally cannot find, since it only ever looks at a document's own text. These get tracked with `via: 'graph'` (keyword matches carry `via: 'keyword'`) so the frontend can label them distinctly (see `frontend.md`). Whether to call this tool at all, and what to do with its results, is now the model's decision rather than an automatic second pass — in practice it reliably does when a document-based answer would benefit from more context, as verified below.

**Architecture** — `server/src/graph.ts`:
- A lazy singleton Neo4j driver (`getDriver()`), reading `NEO4J_URI`/`NEO4J_USERNAME`/`NEO4J_PASSWORD` on first real use rather than at module load — same ESM-import-hoisting reasoning as `db.ts`'s own `.env`-loading fix and `integrations.ts`'s `config()` pattern.
- **Every read and write degrades to a silent no-op if unconfigured or unreachable** — `graphWrite`/`graphRead` both catch and log rather than throw. Ask The Record works exactly as it did before this feature with zero Neo4j credentials set; this is an additive enhancement layer, never a hard dependency. Same tolerance philosophy as the optional Zoom/Google integrations.
- **Schema**: `Project {id, name}`, `Meeting {id, title}`, `Document {id, title, type}`, `Person {id}`, `Task {id, title}`, `Activity {id, kind, occurred_at}` nodes; `(Meeting|Document)-[:IN_PROJECT]->(Project)`, `(Document)-[:FROM_MEETING]->(Meeting)`, `(Meeting)-[:ATTENDED_BY]->(Person)`, `(Task)-[:FROM_MEETING]->(Meeting)`, `(Task)-[:PART_OF]->(Project)` edges — all one-directional and set once, no "remove the stale edge first" logic needed. Two edge types carry real time bounds instead — `(Task)-[:ASSIGNED_TO {valid_from, valid_to}]->(Person)` and `(Person)-[:WORKED_ON {valid_from, valid_to}]->(Project)` — see "Temporal knowledge graph" below.
- `expandRelatedDocuments(seedIds, limit)` runs one three-way `UNION` Cypher query (shared project / shared meeting / shared meeting-attendee) and returns related document ids, which `search.ts` then looks up in the already-loaded in-memory corpus (no second Postgres round trip).

**Sync-on-write call sites** (six, chosen to cover every place a `Project`/`Meeting`/`Document` row is created or its graph-relevant fields change):
| File | Trigger | Graph write |
|---|---|---|
| `projects.ts` | `POST /` (create) | `upsertProject` |
| `projects.ts` | `PATCH /:id` (name change) | `upsertProject` |
| `projects.ts` | file-attach loop (project-creation uploads) | `upsertDocument` per file |
| `meetings.ts` | `POST /` (manual meeting) | `upsertMeeting` + `attendMeeting` per participant |
| `meetings.ts` | `POST /:id/tasks` (task created with an assignee) | `attendMeeting` — see "Task-assignee-derived attendance" below |
| `meetings.ts` | `PATCH /:id/tasks/:taskId` (real reassignment) | `attendMeeting` — same reasoning |
| `knowledge.ts` | `POST /` (manual doc) | `upsertDocument` |
| `integrations.ts` | `upsertSyncedMeeting` (Zoom/Google Meet sync) | `upsertMeeting` + `attendMeeting`, on **every** sync (not just creation — this is data mirroring, not an event log, so a re-sync's updated attendee list should show up too) |
| `integrations.ts` | `upsertGmailMessage` (email sync) | `upsertDocument`, on both insert and update |
| `integrations.ts` | `syncTasksFromSummaryEmail`'s block-level assignee resolution | `attendMeeting` — see below |
| `integrations.ts` | `syncTasksFromSummaryEmail`'s `source_meeting_id` backfill | `linkDocumentToMeeting` |
| `integrations.ts` | `findOrCreateMeetingForEmail`'s new-meeting branch | `upsertMeeting` |

**One accepted inconsistency**: the project-creation file-attach loop's `upsertDocument` call sits *inside* the Postgres transaction's `try` block but isn't part of the Postgres transaction itself (Neo4j isn't in a two-phase commit with Neon). If a later file in the same request fails and the Postgres `ROLLBACK` fires, an earlier file's `Document` node can be left in Neo4j with no matching Postgres row. Not fixed — documented as a known gap below, since building real cross-database transactional consistency is a different, much larger project than what was asked for.

## One-off backfill for pre-existing data
Sync-on-write only covers writes *going forward* — it does nothing for the rows that existed before Neo4j was wired in. `server/src/scripts/backfill-graph.ts` walks every current `projects`/`meetings`/`knowledge_documents` row once and calls the same `graph.ts` upsert helpers, safe to re-run (every helper is a `MERGE`).

**First run found a real, honestly-reported gap**: `projects: synced 1`, `meetings: synced 30 (8 attendance edges)`, `knowledge_documents: synced 27` — but `expandRelatedDocuments()` returned **zero** results for the org's real Gmail-synced content. Traced directly: all 27 real documents have `project_id = NULL`, and each has a *distinct* `source_meeting_id` — `findOrCreateMeetingForEmail()` auto-creates one meeting per summary email, always with `participants: '[]'`. The 3 real Google Meet-synced meetings *did* have real attendee data, but no document was linked to *those* meetings. The three node types the graph tracks simply didn't overlap anywhere in the real data yet — confirmed not a sync bug by creating a disposable test project with two documents (one keyword-matchable, one not, both sharing the project): `POST /chat/ask` correctly returned the keyword-unrelated one with `via: 'graph'`, proving the mechanism itself worked end-to-end; it just had nothing real to expand into.

## Task-assignee-derived attendance — closing the real-data gap (as built)
Direct follow-up ("making the graph feature actually useful") once the gap above was reported. Rather than adding new Gmail-header parsing to capture real meeting attendees, reused a signal that **already fully exists** for all 30 real meetings: `meeting_tasks.assignee_id`. Someone assigned an action item extracted from a meeting's summary is a reasonable stand-in for "connected to this meeting" — looser than "physically attended," but a real, already-collected fact, not a new inference.

Three places now call `attendMeeting(meetingId, assigneeId)`:
- `meetings.ts`'s `POST /:id/tasks`, whenever the created task has an assignee.
- `meetings.ts`'s `PATCH /:id/tasks/:taskId`, inside the existing `isReassignment` branch (a real, non-null, different assignee).
- `integrations.ts`'s `syncTasksFromSummaryEmail`, once per resolved block name (not per bullet item — `attendMeeting` is a `MERGE`, so a person appearing across multiple bullets in the same block is harmless to call for repeatedly, but doing it once per block avoids the redundant calls entirely).

`backfill-graph.ts` gained a matching retroactive step — `SELECT DISTINCT meeting_id, assignee_id FROM meeting_tasks WHERE assignee_id IS NOT NULL`, one `attendMeeting` call per pair — to catch every task assigned *before* these hooks existed, not just future ones.

**Re-ran the backfill**: `meetings: synced 30 (170 attendance edges, incl. task-assignee-derived)` — up from 8. Re-verified `expandRelatedDocuments()` directly against real data (no test entities this time): seeding with the 3 most recent real documents returned 5 real related documents. Re-verified live via `POST /chat/ask` with "what are the action items from the GTM meeting" against the real corpus: response included 2 `via: 'keyword'` sources and 3 genuine `via: 'graph'` sources, all real "Fwd: Meeting assets..." documents connected through shared meeting attendees — the feature now produces real value against the org's actual content, not just disposable test data.

**Also confirmed unaffected**: the Neo4j Aura instance was renamed (display label only, in the Aura console) partway through this work — connection re-verified working immediately after, since the app connects via the URI/credentials in `.env`, which a display-name change doesn't touch.

**What would still add more value**: extending Gmail sync to resolve real attendees from the summary email's own participant data (closer to "actually attended" than "was assigned a task from it"), or assigning existing documents to a project. Neither was needed to get real results this pass — noted as further headroom, not a blocker.

## Temporal knowledge graph (as built)
Direct request to extend the graph so it tracks **relationships over time**, not just relationships. Preceded by an explicit "inspect first, don't build yet" architecture review (published as a standalone artifact) covering current stack, schema, and a straight answer on whether Neo4j was even necessary — it already was: this whole graph layer was live and in production use before the temporal work started. The review's phased plan (Postgres history tables → sync-on-write → backfill → chat tools) was executed in full.

**Naming decision, made and executed**: the very first temporal edge (`ASSIGNED_TO`, built earlier for a task-assignment prototype) used `from`/`until` property names. Standardized on **`valid_from`/`valid_to`** across every temporal edge going forward, and migrated the then-existing 8 real `ASSIGNED_TO` edges in place (`SET r.valid_from = r.from, r.valid_to = r.until REMOVE r.from, r.until`) rather than leaving one relationship type inconsistent with the rest.

**New Postgres table** — `project_history` (mirrors `task_activity`'s exact shape: `actor_id`, `action IN ('status_changed','owner_changed')`, `from_value`/`to_value`, `created_at`). Projects previously only ever held their *current* status/owner; there was no way to ask what a project's status used to be.

**Closed a real historical-completeness gap in `task_activity`**: it only ever logged *re*assignment — the very first assignment, made at task-creation time, was never logged as an event. Of 366 real tasks, only 4 had ever been reassigned, so only those 4 had *any* assignment history; the other 362 had a current assignee with no recorded "since when." Both task-creation paths (`meetings.ts`'s `POST /:id/tasks`, `integrations.ts`'s Gmail auto-extraction) now log an `assigned` row at creation too, not just on reassignment.

**New `graph.ts` primitives**:
| Function | Adds |
|---|---|
| `linkTaskToProject` | `Task-[:PART_OF]->Project`, derived one hop through the task's meeting (a task's project was never stored directly — see the architecture review's schema finding) |
| `closeOpenTaskAssignment` | Closes whatever `ASSIGNED_TO` period is currently open on a task. Needed because a *live* reassignment, unlike the backfill, can't look ahead to know a period's end in one pass — a real reassignment is always two writes: close the old one, open the new one with `valid_to` left null |
| `recordProjectInvolvement` | `Person-[:WORKED_ON {valid_from, valid_to}]->Project`. No project-membership table exists, so this is derived from real observed activity (task assignment, project ownership) rather than new membership CRUD. `valid_from` is first-ever observed involvement; `valid_to` keeps extending forward — never "closed" by someone else's involvement, since multiple people can work on one project at once, unlike the exclusive `ASSIGNED_TO` |
| `recordActivity` / `getProjectActivitySince` | `Activity {id, kind, occurred_at}` — a first-class node per real event, `Person-[:PERFORMED]->Activity-[:RELATED_TO]->Task\|Project`. Unifies `task_activity` events and `project_history` events into one queryable event log the graph can traverse |

**Sync-on-write, extended to every real write site for the above**: `projects.ts` (`POST /` records the owner's initial involvement; `PATCH /:id`'s status/owner branches now only fire on an *actual* change — same no-op guard style as `meetings.ts`'s `isReassignment` — and log to `project_history` + `recordActivity` + `recordProjectInvolvement` for a new owner), `meetings.ts` (`POST /:id/tasks` now calls `upsertTask`/`linkTaskToProject`/`recordTaskAssignment`/`recordActivity` live — previously `upsertTask`/`recordTaskAssignment` were **never called outside the backfill script**, meaning the temporal graph was a point-in-time snapshot that silently stopped tracking new tasks; `PATCH /:id/tasks/:taskId` now does the close-then-open dance on real reassignment, plus logs `done`/`reopened` as `Activity` nodes too), `integrations.ts` (`syncTasksFromSummaryEmail` gained the same wiring for both its new-task and ambiguous-name-repair branches — since this path runs as a background sync with no `req.user`, the real person who triggered the sync, `req.user!.id` from the `/gmail/sync` handler, is threaded through as `syncedByUserId` and used as the activity actor, rather than fabricating a system account).

**Backfill** (`backfill-temporal-graph.ts`, extended) — real numbers from the live org: `task-project links: synced 0`, `project ownership involvement: synced 1`, `task-assignee project involvement: synced 0`, `assignment history: synced 8 time-bounded edges across 4 tasks`, `activity: synced 15 Activity nodes`. The two zeros are correct, not bugs — no real meeting in this org has a `project_id` set yet, so `PART_OF` and task-derived `WORKED_ON` genuinely have nothing to sync into today. Confirmed and cleaned a stale `test-id-123` Project node left over from earlier ad-hoc testing before this backfill ran, so it wouldn't pollute the new WORKED_ON/PART_OF queries.

**Verified live, not just via backfill**: created a real disposable meeting+task assigned to one real person, confirmed the `Task` node and `ASSIGNED_TO` edge appeared in the graph immediately (no backfill run); reassigned it to a second real person via the real `PATCH` endpoint, confirmed the first person's edge got `valid_to` set to the reassignment instant and the second person's edge opened with `valid_to: null`; changed a real project's status via the real `PATCH` endpoint, confirmed a `project_history` row and a graph `Activity {kind: 'status_changed'}` node both appeared, then reverted the status back (the two status-change events remain as genuine history — an honest byproduct of live testing, not fabricated data, same as any other audit trail picking up test traffic).

**Deliberately not built** — no source data exists for either, and inventing it would mean building new unrelated functionality, not modeling existing facts: `Task-[:DEPENDS_ON]->Task` (task dependencies aren't modeled anywhere in Postgres) and `CalendarEvent` (no `calendar_events` table — "calendar views" are computed on the fly from `meeting_tasks.due_date` and `leave_requests`, never stored as their own entity).

**No dedicated frontend UI** — per the architecture review's own recommendation, deferred in favor of proving value through Ask The Record's chat tools first. All three new tools' underlying logic is confirmed correct against real data (`executeTool()` called directly, bypassing the LLM) — see "Agent loop bug" immediately below for the one piece that isn't yet live-confirmed end-to-end.

## Bug found (and partially confirmed fixed): the agent loop silently discarded its last round's results
Surfaced while doing the live end-to-end verification above — `get_task_assignment_history` answered correctly through the real chat agent, but `get_project_change_history` consistently returned the generic "wasn't able to work out a clear answer" fallback despite `executeTool()` returning correct data on the very first tool call. Traced with `CHAT_DEBUG=1` (a temporary env-gated trace added to `chatAgent.ts`'s loop, kept — harmless when unset, clearly useful for the next time this class of bug shows up), not guessed:

1. **The model re-queried the same already-answered question four times** with trivially different arguments (`sinceDaysAgo: 1`, then an unrelated `find_projects` check, then `find_tasks`, then `sinceDaysAgo: 7`) instead of settling on an answer after round 0's data was already sufficient — a real model behavior, not something this fix controls.
2. **The actual bug**: `answerQuestionWithAgent()`'s loop only ever sent a round's tool results back as the *next* round's message. Once `MAX_TOOL_ROUNDS` (4) was reached, the last round's results were computed and then simply discarded — the model was never given a turn to read them and answer, so the loop always fell through to the generic fallback whenever a question needed the full round budget, regardless of whether the data needed to answer it had already been fetched.

**First fix attempt** — add one more `chat.sendMessage()` call after the loop, using the last round's results. Insufficient on its own, confirmed by re-tracing: the model kept calling *another* tool on that extra turn too, since it still had every tool available.

**Actual fix**: that final call now passes `config: { tools: [] }`. Per-request config in this SDK replaces the chat session's tool list rather than merging with it, so with none available the model has no choice but to answer in plain text from whatever it already gathered — conversation history (including every prior round's real tool results) stays visible to it regardless, since that's tracked independently of this override.

**Status: type-checks clean, logically sound against the documented SDK behavior, not yet live-confirmed.** Re-testing hit the same Gemini free-tier daily quota wall documented earlier in this doc (20 requests/day) mid-verification — the fix should be re-tested against the exact repro question ("What changed in the Navedas IQ project in the last day?") once quota resets, before treating this as fully closed.

## Bug found + fixed: the chatbot dumped entire raw emails instead of answering
Reported directly: "the chatbot is not answering properly and correctly." Reproduced via `POST /api/chat/ask` against the live corpus (25 synced Gmail messages, all near-duplicate forwarded Zoom AI meeting-summary emails, subjects like "Fwd: Meeting assets for Navedas Intelligence are ready!"). Root cause, confirmed by direct reproduction (not guessed):

1. **The retrieval pipeline (this predates the LLM agent above) returned the entire top-scoring doc's `excerpt` verbatim as the "answer."** That was fine when the corpus was 12 short (~500 char) hand-authored SOP/FAQ/decision docs — the whole excerpt basically *was* the answer. It breaks completely once the corpus is long (up to 8000 char), multi-topic meeting-summary emails: every question, no matter how specific, got the *entire* email dumped back — headers, every topic discussed, every person's action items — not just the part that answered the question.
2. **The answer literally started with email-forwarding boilerplate** (`---------- Forwarded message ---------` + From/Date/Subject/To headers) rather than real content, since nothing ever stripped it.
3. **`idf()` never reaches 0**, so the old `score > 0` filter meant almost any word that appeared *anywhere* in the corpus counted as a "match." Concretely: every synced email is from `hello@navedas.com`, so the single word "hello" scored a nonzero match against every document and returned a full document dump for what is not really a question at all.

**Fixed** in `server/src/search.ts`:
- `stripEmailBoilerplate()` — strips the forwarded-message header block. Written to strip from the marker through the first *blank line* that follows it, rather than trying to match each header line individually — the `Subject:` line frequently line-wraps with no header-keyword prefix on the continuation line, which broke an earlier line-by-line regex attempt (left a stray `To: <hello@csat.ai>` fragment as its own "paragraph").
- `extractAnswerSnippet()` — splits the cleaned excerpt into paragraphs (`splitParagraphs()`, also filters out link-only paragraphs via `URL_ONLY_RE` so a bare `<https://zoom.com>` line never gets returned as "the answer"), scores each paragraph against the query terms using the same `tf * idf` weighting as document-level scoring, and returns the top 1-2 matching paragraphs instead of the whole excerpt. Falls back to the first paragraph if nothing scores (single-paragraph docs, e.g. the original short SOP/FAQ content, degrade gracefully to their old full-excerpt behavior since there's nothing to split).
- `MIN_ANSWER_SCORE = 2` — `searchOrgKnowledge()` now requires a document's score to clear this floor instead of just `> 0`, so weak/incidental matches (like "hello" hitting every doc's sender address) correctly fall through to the "I couldn't find anything" response instead of returning a near-random document.
- `buildIndex()` — factored the corpus-loading + idf-weight-building logic into a shared helper, reused by both `keywordSearchDocuments()` and `extractAnswerSnippet()`'s paragraph scoring.

Verified via direct calls against the live 25-email corpus: "What are the action items from the GTM meeting?" now returns a ~1.6KB focused passage (the actual "Review action items" + summary paragraph) instead of the full 8000-char email; "hello" now returns the "couldn't find anything" fallback instead of a document dump; a genuinely nonsense query still correctly returns no match. Also confirmed live in the browser via the chat drawer. (This was true of the old direct-answer pipeline; still true now that the same function backs the `search_documents` tool — the LLM agent receives the same focused passage, not the whole email, as its tool result.)

Also surfaced (and fixed, see `frontend.md`) a related frontend bug: the chat bubble had no `whitespace-pre-wrap`, so paragraph breaks in the extracted snippet would have collapsed back into a run-on wall of text in the UI even after this fix.

## Auth
`requireAuth`, every tool in `chatTools.ts` takes `orgId` from `req.user.org_id` and scopes its query to it — never returns another org's data, regardless of what the model is told or asked to do (the model never sees or chooses `orgId`; it's closed over server-side). No per-project or per-document ACLs yet (see original spec's note on meeting-transcript sensitivity — still an open concern, not yet modeled).

## Open gaps
- No conversation history/context across turns — each `ask()` starts a fresh Gemini chat session with no memory of previous questions, and now doubly so since nothing is logged server-side either.
- No caching of the corpus/IDF weights inside `search_documents` — rebuilt from scratch on every call.
- No usage analytics beyond the per-document `view_count` — nothing about *what* was asked, *when*, or *by whom*. If a future version wants to know "what do people ask the bot," that data collection would need to be reintroduced deliberately (e.g. anonymized/aggregated only), not just restoring `chat_queries` as-is.
- `view_count` only increments when a document is cited via `search_documents`/`expand_related_documents` — a document that's important but never comes up as a citation (or that the agent answers from a structured tool instead of citing) will never register as "popular," regardless of its actual value.
- No cascade-delete from Postgres to Neo4j — trashing/deleting a document, project, or meeting leaves its graph node orphaned. Not yet hit in practice (nothing deletes projects, and knowledge-doc deletion is soft/trash-based except the permanent-delete path), but a real gap if the graph is ever relied on more heavily.
- `PART_OF`/task-derived `WORKED_ON` have zero real edges today — not a bug, just genuinely nothing to sync until a real meeting gets a `project_id` set. Worth re-checking once that starts happening in practice.
- No `DEPENDS_ON` or `CalendarEvent` support — deliberately not built, no source data exists for either (see "Temporal knowledge graph" above). Would need new, unrelated app functionality first, not just more graph modeling.
- `WORKED_ON`'s `valid_to` only ever extends forward on new observed activity — it's never "closed" the way `ASSIGNED_TO` is, so it can't currently answer "when did X stop working on Y," only "when were they last observed active on it."
- No cross-database transactional consistency — see the project-creation file-attach loop's "accepted inconsistency" note above. Neo4j sync failures are logged (`console.error`) but never surfaced to the user or retried.
- `expandRelatedDocuments`'s `limit` parameter is templated directly into the Cypher string rather than bound — safe today since every caller passes an internal constant, never user input, but worth bearing in mind if a future caller ever passes anything derived from a request.
- Real per-question LLM cost now applies (Gemini Flash, small but nonzero) — every `POST /api/chat/ask` call is at least one Gemini request, more if the model chains tool calls. No rate limiting or per-user/per-org quota exists yet.
- `MAX_TOOL_ROUNDS = 4` is an unenforced-elsewhere constant — if a question needs more than 4 rounds of tool calls to answer, the agent gives up with a generic "wasn't able to work out a clear answer" rather than a more specific explanation of what it was still trying to do.

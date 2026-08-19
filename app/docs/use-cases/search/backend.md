# Global Search — Backend

**Status: built.** Lives in `server/src/routes/search.ts`. Separate from (and simpler than) the Ask The Record retrieval engine — this is substring matching for a quick top-bar dropdown, not TF-IDF ranking for a chat answer.

## Endpoint

`GET /api/search?q=<query>` (requireAuth) — no query means empty results (`{ projects: [], meetings: [], documents: [] }`), not an error.

### Query logic
Three independent `LIKE '%q%'` queries, scoped to `req.user.org_id`, each capped at `RESULT_LIMIT = 5`:
- `projects`: match on `name`.
- `meetings`: match on `title` OR `summary`.
- `knowledge_documents`: match on `title` OR `excerpt`.

SQLite's `LIKE` is case-insensitive for ASCII by default, so no explicit lowercasing needed.

### Response shape
```jsonc
{
  "projects": [{ "id": "...", "name": "Rollback Runbook", "status": "on_track" }],
  "meetings": [{ "id": "...", "title": "...", "scheduledAt": "..." }],
  "documents": [{ "id": "...", "title": "...", "type": "sop" }]
}
```

## Why this isn't the same engine as Ask The Record
Deliberately kept separate and simpler: this is "find the thing you're looking for by name," not "answer a natural-language question." Reusing the TF-IDF/IDF-weighted retrieval from `search.ts` (the chat engine) would be overkill for exact/substring name matching and would surface confusing partial-relevance results in a UI dropdown where users expect literal matches.

## Auth
`requireAuth`, all three queries scoped to `req.user.org_id` — same pattern as every other route.

## Open gaps
- No ranking beyond `ORDER BY updated_at DESC` / `scheduled_at DESC` — a query matching many documents just returns the 5 most recently updated, not the "most relevant" 5.
- No cross-entity relevance ranking (e.g. a project name match isn't weighted against a document title match) — each category is queried and limited independently.
- No fuzzy matching / typo tolerance — pure substring `LIKE`.

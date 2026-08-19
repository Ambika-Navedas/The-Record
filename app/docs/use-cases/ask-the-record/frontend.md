# Ask The Record (Chat) — Frontend

## Where it lives
Not a route — a persistent overlay mounted once in `AppLayout` (`src/components/AppLayout.tsx`), wrapped in `<ChatDrawerProvider>`, so it's present on all four `/app/*` pages and shares one conversation across tab switches. Deliberately excluded from the public `/` landing page.

## Component structure
- `src/context/ChatDrawerContext.tsx` — `ChatDrawerProvider` + `useChatDrawer()` hook. Holds `isOpen: boolean` and `messages: ChatMessage[]` state. Exposes `open()`, `close()`, `ask(question: string)`.
- `src/components/ChatDrawer.tsx` — the FAB button + backdrop + sliding drawer UI, plus its own local `input` state for free-text typing.
- Entry point into `ask()`: the drawer's own input box. (The Dashboard used to have a second entry point — a card with a canned example query — but it was removed per direct request since the FAB already covers the same job; see `dashboard/frontend.md` and `dashboard/design.md`. The FAB is now the sole way to open the drawer.)

## How `ask()` works now (real API call, not client-side retrieval)
```ts
function ask(question: string) {
  const userMsgId = crypto.randomUUID()
  const pendingId = crypto.randomUUID()
  setMessages((prev) => [...prev, { id: userMsgId, role: 'user', text: trimmed },
                                    { id: pendingId, role: 'bot', text: 'Searching…', pending: true }])
  setIsOpen(true)
  api.post<ChatAnswer>('/chat/ask', { question: trimmed })
    .then(({ answerText, sources }) => { /* replace the pending message with the real answer */ })
    .catch(() => { /* replace with a connection-error message */ })
}
```
The client-side TF-IDF engine that used to live in `src/lib/search.ts` **has been deleted** — it was fully ported to the server (`server/src/search.ts`), then later reduced to just one tool (`search_documents`) inside a real LLM agent (see `ask-the-record/backend.md`'s "LLM agent architecture") rather than the whole answer pipeline. None of this is visible to the frontend — `ChatAnswer`'s shape (`answerText`, `sources`) hasn't changed, so `ask()` itself didn't need to change when the backend swapped from pure keyword retrieval to a Gemini-backed agent, or when that agent's provider later swapped from Anthropic to Gemini. The frontend just shows an optimistic "Searching…" bubble and replaces it once `POST /api/chat/ask` resolves. See `ask-the-record/backend.md` for how the answer actually gets produced now.

## Graph-related sources labeled distinctly (as built)
Direct follow-up once Neo4j-backed retrieval expansion landed server-side (see `backend.md`'s "Graph-expanded retrieval" section): `ChatAnswer['sources']` gained a `via: 'keyword' | 'graph'` field, and the sources line in `ChatDrawer.tsx` renders graph-surfaced documents with a `(related)` suffix (`` `${s.title} (related)` ``) instead of the bare title — a plain-text distinction, not a badge/pill, matching the existing minimal `Sources: {title} · {title}` line's style rather than introducing new visual chrome for one field.

## Bug found + fixed: paragraph breaks in answers were collapsing into a wall of text
The chat bubble (`ChatDrawer.tsx`) rendered `{m.text}` inside a plain `<div>` with no `whitespace-pre-wrap` — harmless while the backend returned a single unbroken excerpt, but once the backend fix (see `backend.md`) started returning answers built from 1-2 real paragraphs joined with `\n\n`, the missing style would have silently collapsed those line breaks back into one run-on block (standard HTML whitespace collapsing). Fixed by adding `whitespace-pre-wrap` to the message bubble's className — same class already used correctly for the excerpt on `KnowledgeDetailPage.tsx`. Verified live in the browser: multi-paragraph answers now render as separate paragraphs in the drawer.

## Known gaps
- No conversation memory/context — each `ask()` call is independent server-side too (see backend.md); a follow-up question doesn't know about the previous turn.
- Answer text is now a focused 1-2 paragraph excerpt (see backend.md's passage-extraction fix) rather than the whole document, but it's still lifted verbatim from the source — no generation/paraphrasing.
- Drawer state resets on full page reload (React state only, nothing persisted client-side, and nothing persisted server-side either — see backend.md, query logging was deliberately removed).
- No "no results" UI polish beyond the plain fallback string from the server.
- `(related)` sources currently have nothing to click through to a "why is this related" explanation — the connection (shared project/meeting/attendee) is real but invisible beyond the label itself.

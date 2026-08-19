# Global Search — Frontend

## Where it lives
`src/components/SearchBar.tsx`, mounted once in `AppLayout`'s top bar (same placement as the original static "🔍 Search projects, docs, meetings…" div it replaced). Present on all four `/app/*` pages, not on the public landing page — same scoping as the chat FAB.

## Why it exists
The top bar always had a search-styled element per the original design spec (Prompt 2), but it was a plain `<div>` with placeholder text — not an `<input>`, no behavior. The user asked "why the search field is not working," which surfaced the gap; this component makes it real.

## Component structure
- Controlled `query` state (`useState`), debounced fetch on change.
- `open` state — dropdown visibility, closed on outside-click (`mousedown` listener on a container `ref`) or after a result is clicked.
- `results: SearchResponse` — `{ projects, meetings, documents }`, grouped and rendered as three labeled sections in a dropdown panel below the input.

```ts
useEffect(() => {
  if (!query.trim()) { setResults(EMPTY); return }
  setLoading(true)
  const timer = setTimeout(() => {
    api.get<SearchResponse>(`/search?q=${encodeURIComponent(query.trim())}`)
      .then(setResults).catch(() => setResults(EMPTY)).finally(() => setLoading(false))
  }, 250)
  return () => clearTimeout(timer)
}, [query])
```

## Result click behavior
Since no detail pages exist anywhere in the app yet, clicking any result navigates to that result's **section page** (`/app/projects`, `/app/meetings`, or `/app/knowledge`) rather than a specific item — the honest option given current app capabilities, instead of inventing a fake deep-link. Revisit once detail pages exist.

## Known gaps
- Clicking a result doesn't scroll to or highlight the specific item on the destination page — it just navigates to the section, same limitation as the "no detail pages" gap everywhere else.
- No keyboard navigation within the dropdown (arrow keys / Enter to select) — mouse/click only.
- No debounce-in-flight cancellation — if a fast typist changes the query while a request is in flight, an older response could in theory resolve after a newer one (no request-ID guard). Unlikely to matter at demo scale.

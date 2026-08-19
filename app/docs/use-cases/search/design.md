# Global Search — Design

## Design history
Not explored via `/design-shotgun` — the search bar's *appearance* was already fixed by the original Prompt 2 spec (a search-styled box in the top bar, ~300px wide, light gray background, magnifying glass icon). What was missing was behavior, not visual design, so this was a straight functional implementation on top of the existing look rather than a new design exploration.

## Visual anatomy
- Input box: identical styling to the original static placeholder div (`bg-page`, `border-border`, `rounded-lg`, focus ring in `accent-tint` on focus) — swapped a `<div>` for a real `<input>` with no visual change.
- Dropdown panel: appears directly below the input (`absolute`, `top-[calc(100%+6px)]`), white background, same card shadow/radius language as the rest of the app (`shadow-[0_20px_50px_-20px_rgba(27,28,34,0.25)]`).
- Results grouped into three labeled sections (Projects / Meetings / Knowledge Base) with small-caps muted section labels, matching the "YOUR PROJECTS" section-label style already established on the Dashboard.
- Each result row: title + a secondary muted label (status for projects, date for meetings, type for documents) — right-aligned, consistent with the list-row pattern used on Projects/Meetings/Knowledge Base pages.

## States
- Empty query: dropdown doesn't render at all (no "start typing" placeholder state).
- Loading: "Searching…" text row.
- No results: `No results for "{query}"` text row.
- Results: grouped sections, only rendering sections that have at least one match (an org with no matching meetings just omits the Meetings section entirely rather than showing "Meetings (0)").

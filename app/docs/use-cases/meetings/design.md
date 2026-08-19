# Meetings — Design

## Design history
Built in the same pass as Projects and Knowledge Base — all three were scoped together in response to "I want to add more pages to it like view all the projects, meeting assets, knowledge based etc," using the Dashboard's approved design system directly rather than running a fresh `/design-shotgun` pass. Layout choice (row list vs. grid) was made per-page based on content shape: Meetings is inherently chronological/linear, so it's a vertical list of rows rather than a card grid (unlike Projects and Knowledge Base, both grid/list-of-cards).

## Layout
- `.mrow` — icon (🎙️) + title/project-tag/summary (left, flexible width) + participants/when/sync-badge/view-link (right, fixed width). Summary line uses `overflow-hidden text-ellipsis whitespace-nowrap` — long summaries truncate to one line rather than wrapping, by design (keeps every row the same height in a dense list).

## Palette
"Processing" sync badge originally used the amber accent color; changed to the neutral `pill-muted` gray/muted style in the same cleanup pass that removed amber from Projects and Knowledge Base's freshness dots (see `dashboard/design.md` for the full rationale). "Synced" remains green — it's a genuinely positive/complete signal, consistent with the two-color rule.

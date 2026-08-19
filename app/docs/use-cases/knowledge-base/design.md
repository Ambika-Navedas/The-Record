# Knowledge Base — Design

## Design history
Built alongside Projects and Meetings in the same "add more pages" pass, directly on the Dashboard's approved design system (no separate `/design-shotgun` run).

## Layout
Row-list layout (like Meetings, unlike Projects' card grid) — chosen because knowledge items are naturally a flat browsable/searchable index, not distinct cards with their own internal structure. Each row: type icon (left), title + type/project/owner metadata (center, flexible), freshness indicator (right, fixed width).

## Palette — the one page that needed a retrofit
Originally shipped with per-type icon colors: blue tint for SOP, amber tint for Decision, green tint for FAQ. Removed entirely per the "minimal colors" feedback — **all doc-type icon badges are now neutral gray** (`bg-page`/`text-muted`), relying on the icon glyph (📋/🎙️/⚖️/❓) and the `type` text label to distinguish categories rather than color-coding them. This was a deliberate step further than the amber-only removal done elsewhere: even the *positive-feeling* green FAQ icon was flattened, because it wasn't actually signaling anything (FAQs aren't inherently "good," they were just assigned a color for visual variety).

Freshness dots kept the two-color rule: green for fresh, gray for everything else — no amber "getting stale" middle state, even though the data conceptually has one (a document updated 12 days ago vs. 2 hours ago). This mirrors the on-track/attention/blocked decision on Projects: middle states share the neutral gray rather than earning a third color.

## Gmail sync bar
Added directly on top of the existing card component used for Meetings' Zoom/Google Meet sync bar — same border/radius/padding, no new visual language introduced. The search-query input and Save button (unique to Gmail among the app's syncs, since only Gmail needs a mandatory filter — see backend.md) use the same plain bordered-input styling as every other text field in the app, kept deliberately unremarkable rather than treated as a "special" or highlighted control.

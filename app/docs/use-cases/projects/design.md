# Projects — Design

## Design history
Not run through `/design-shotgun` as a standalone visual exploration — built directly to match the already-approved Dashboard (Variant B) design system, per the user's request to add "view all projects" as a new page rather than re-litigate the visual direction. Navigation pattern (top tabs vs. left sidebar) was decided at this point: **top nav tabs** chosen over a left sidebar, to keep the existing top-bar-only layout rather than introduce a new structural element for 4 sections.

## Layout
- 4-column card grid (`grid-cols-4`), denser than the dashboard's project row (which is a horizontally-scrolling strip of the same card style at `min-width: 196px`).
- Filter chips (`All · 8`, `On track · 4`, etc.) — pill-shaped, dark-filled when active, matching the same chip style later reused on Meetings and Knowledge Base for consistency.

## Palette
Same two-color rule as the rest of the app: green only for "On track," everything else (`Needs attention`, `Blocked`) renders as neutral gray — both share the same gray dot and `pill-muted` background, distinguished purely by their text label. This was a direct consequence of the amber-removal pass done on the Dashboard (see `dashboard/design.md`) — Projects was built after that pass, so it launched clean rather than needing its own retrofit.

## Card anatomy
Name + status pill (top), **description** (new, `line-clamp-2`, only when present), owner avatar + name, doc/meeting counts, "Updated X" with status dot. The description line was added specifically because the card without it read as name-and-metadata only — "not worthful," per the user's framing when asking for real project details to be addable.

Whole card is now a button (`onClick` opens the edit modal) rather than a static div — no new visual affordance was added to signal this (no "edit" icon, no hover-reveal pencil), relying on the existing card hover-lift (translate + shadow, already present from the Dashboard variant) to read as "this is interactive." Worth revisiting if that turns out to be too subtle.

## "+ New project" button relocation
Originally lived in the shared top bar (`AppLayout`), visible on every logged-in page. Moved here, top-right of the page heading, per direct request: project creation should only be reachable from the page that's actually about projects, not globally. Styled identically to its original top-bar appearance (gradient accent button) — just relocated, not redesigned.

## Create/edit modal
One modal design serves both creating and editing (see `projects/frontend.md` for the shared-state mechanics) — same white rounded card, same click-to-dismiss dark backdrop pattern already established by `ChatDrawer`. Fields: name (text input), description (textarea), status + owner side by side as two `<select>` elements in a 2-column sub-grid. No new component library was introduced for the dropdowns — plain native `<select>`, styled to match the text inputs (same border/radius/focus-ring treatment), consistent with the rest of the app's "no component library, just Tailwind on native elements" approach.

Below status/owner, the modal adds Git URL and Deployment URL as full-width text inputs, then Username + Password side by side in a second 2-column sub-grid — same input styling as every other field, no visual distinction to flag them as "sensitive" (no lock icon, no reveal/hide toggle). This was a deliberate consequence of the user's "keep as normal text" instruction for the password field: since it's stored and displayed as plain text by design, it gets no special treatment. These four fields are modal-only — the project card was intentionally left unchanged, per the user's explicit choice when asked where the fields should surface.

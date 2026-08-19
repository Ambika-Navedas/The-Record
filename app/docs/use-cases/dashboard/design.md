# Dashboard — Design

## Design history
Explored via `/design-shotgun` as three execution variants (theme already locked to the landing page's baseline choice, so these varied layout/polish, not color):
- **A — Exact Spec**: faithful build of Prompt 2 from `the-record-antigravity-prompts.md`.
- **B — Polished/Detailed**: same layout, added gradient bars/ring, card hover-lift, refined icon badges.
- **C — Dense/Power-User**: same tokens, tighter padding, smaller cards.

**Approved: Variant B (Polished/Detailed)** — logged in `~/.gstack/projects/TheRecord/designs/dashboard-20260728/approved.json`. This became the base that the floating chat button + drawer and the later Projects/Meetings/Knowledge Base pages were all built to match.

## Palette (later revised)
Originally shipped with a third accent color (amber, `#C98A2C`) for "Needs attention" status pills, dots, and the "Processing" sync badge. **Removed** per explicit feedback ("avoid using so many font colors, just use minimal colors") — the app now strictly follows the original spec's two-color rule: **blue** (`--color-accent`) for action/accent, **green** (`--color-green`) only for positive/on-track signals. Everything else — "Needs attention," "Blocked," avatars, doc-type icons — is neutral gray/ink, differentiated by text and iconography, not color.

Avatars were also flattened from a 3-hue set (blue/purple/green) to a single neutral `#4B4C58` for the same reason — avatar color was decorative, not a status signal, so it didn't need to compete with the two meaningful colors.

## Layout
- **2-column bento grid** (`grid-cols-2`, changed from `grid-cols-3`), now 5 cards: row 1 = Knowledge Health + Next Event; row 2 = Today's Meeting Update + Most Popular Content; row 3 = Documents by Type (`col-span-2`, full width). The 2-column switch (made when the card count dropped to 3, after three rounds of removal) turned out to scale well in the other direction too — adding 2 more cards just meant one more clean row, no col-span rebalancing needed at all. This is the payoff of that earlier decision to simplify the grid instead of continuing to patch a 3-column layout.
- Hover state added in Variant B: cards lift (`-translate-y-0.5`) with a soft shadow on hover — not in the original spec, added as part of the "polished" direction.

## Floating chat button + drawer
Added after the dashboard design was approved, in response to a direct feature request (not part of `/design-shotgun`). Bottom-right FAB (56px circle, gradient accent, green "active" dot), opens a 400px right-side drawer on click. Scoped to logged-in pages only (`AppLayout`) — deliberately excluded from the public landing/login page per an explicit scope decision at the time.

## Post-backend trims (real data replacing the mock)
Once the dashboard started fetching real aggregated data instead of hardcoded numbers, a few visual elements were removed rather than faked:
- The dashed "+ New project" tile at the end of the "Your projects" row — removed per direct request; project creation now lives only on the Projects page.
- The "+6%" / "+12% this month" green delta pills on the Knowledge Health and Documents by Type cards — dropped since there's no historical snapshot to compute a real delta against (see backend.md).
- The attendee-avatar row under the "This month" calendar — dropped since per-day attendee data isn't modeled server-side yet.

The "+ New project" button itself wasn't deleted — it moved to the Projects page (see `projects/design.md`), since the user wanted it scoped to where projects are actually managed rather than available from every page via the shared top bar.

## "Questions answered" card — removed
The fifth bento card (question count + resolution-rate ring) was removed entirely once chat query logging was turned off (see backend.md and `ask-the-record/backend.md`) — its numbers had no data source left. Rather than leave a dead/zeroed card, it was deleted and the grid rebalanced (see Layout above).

## "Next event" card — added
Replaced the empty slot left by removing Questions Answered. Visual language deliberately reuses the existing "This month" card's mini-calendar pattern (weekday-letter header row + a row of circular date cells, `grid-cols-7`) rather than inventing a new calendar widget — the only difference is the date cells show the actual day-of-month number (not a plain dot) and only the event's day is filled (accent gradient), the other six are outlined/muted. Below the strip: event title, project tag, date, time, duration — same text hierarchy as other card content (bold title line, muted meta line). Falls back to "No upcoming meetings scheduled." if there's nothing in the future, rather than hiding the card or showing an empty calendar.

## "Ask The Record" card — removed
Removed per direct request: the floating chat FAB + drawer (present on every logged-in page, added earlier — see "Floating chat button + drawer" above) already provides the same entry point, so the dashboard-specific card promoting it was redundant. This was flagged as a candidate for removal during an earlier exploratory discussion ("it's not strictly necessary... it doubles as onboarding copy") before the user decided to cut it. "Meeting sync activity" (previously "This month") was widened to `col-span-2` to fill the resulting gap in row 2, mirroring the exact same rebalancing move made when Questions Answered was removed.

## "Meeting sync activity" card — removed, grid simplified to 2 columns
Removed per direct request after a conversation comparing it to the new Next Event card — both shared the same weekday-header + circular-cell visual pattern, which made them look redundant even though they showed different things (one a specific upcoming meeting, the other a look-back activity heatmap). Once that overlap was pointed out, the user chose to cut the summary card rather than visually differentiate it further.

With only 3 cards left (Knowledge Health, Next Event, Documents by Type), a 3-column grid would have needed yet another col-span rebalance to avoid a dangling third cell in row 1. Instead of continuing to patch col-spans card-removal after card-removal, the grid itself was simplified to `grid-cols-2` — 2 narrow cards in row 1, Documents by Type spanning full width in row 2.

## "Today's meeting update" and "Most popular content" cards — added
Two new cards, requested together. Both follow the same established card anatomy (bold title line, muted meta line below) rather than introducing new visual patterns:
- **Today's meeting update** reuses the Meetings page's sync-status pill styling (green "Synced" / muted "Processing"/"Failed") so a user who's seen that page recognizes the same signal here.
- **Most popular content** reuses the Knowledge Base page's per-type icon treatment (neutral gray badge, type-specific emoji) and adds a new accent-colored "Cited N times" line as the one piece of genuinely new visual vocabulary in this round — accent blue was chosen (not green) because a citation count isn't a "positive/negative" signal, it's a fact worth drawing the eye to, which is what the accent color is for elsewhere in the app (links, primary actions).

Both cards slotted into row 2 of the now-2-column grid without any layout rework — direct validation of the "simplify to 2 columns" decision made in the previous round.

# Ask The Record (Chat) — Design

## Design history
Not part of the original `the-record-antigravity-prompts.md` spec or any `/design-shotgun` pass — added as a direct feature request after the Dashboard design was already approved: "I need the chat bot like an icon placed in every page in the lower right corner and when clicked, it should be opened from the right drawer." Built by hand to match the already-locked design system rather than explored as variants, since the interaction pattern (FAB + drawer) was specified directly by the user rather than left open.

## Scope decision
A follow-up question at build time settled where the FAB appears: **logged-in app pages only**, not the public landing/login page — reasoning being there's no authenticated context (and nothing org-specific) to chat about before login.

## Visual anatomy
- **FAB**: fixed bottom-right, 56px circle, gradient fill (`from-accent-2 to-accent`), small green dot top-right signaling "active"/available (the one non-status use of green in the app — an exception to the "green = positive signal" rule, tolerated because it's a tiny secondary indicator, not a competing focal color).
- **Backdrop**: 25%-opacity ink scrim, click-to-close.
- **Drawer**: 400px fixed width (`max-w-[92vw]` for narrow viewports), slides in from the right (`translate-x-full` → `translate-x-0`, 250ms ease), full height, white background matching card styling elsewhere.
- **Messages**: user bubbles right-aligned solid accent blue; bot bubbles left-aligned neutral gray/bordered — standard chat-bubble convention, with a "Sources:" line appended under bot messages listing matched document titles, directly visualizing the product's core promise ("get an answer with sources, not a folder to dig through").

## Consistency with the rest of the app
Reuses the same badge-icon treatment (pale-blue-gradient rounded square with a chat emoji) as the Dashboard's "Ask The Record" card, so the drawer's header doesn't introduce a new visual motif — it's the same icon "docked" into a different container.

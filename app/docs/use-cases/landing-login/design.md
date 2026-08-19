# Landing / Login — Design

## Design history
Explored via `/design-shotgun` as three directions before any code was written:
- **A — Baseline Spec**: faithful to the original written spec (`the-record-antigravity-prompts.md`, Prompt 1). White/`#F7F7F9`, blue accent, Space Grotesk + Inter.
- **B — Warm Editorial**: cream background, italic Fraunces serif headline, muted indigo accent.
- **C — Bold AI-Native**: dark gradient hero, frosted-glass login card.

**Approved: Variant A (Baseline Spec)** — logged in `~/.gstack/projects/TheRecord/designs/landing-20260728/approved.json`.

After approval, the page was trimmed down through several rounds of direct feedback:
1. Removed nav links ("Product ⌄ / Solutions ⌄ / Resources ⌄ / Pricing") and "Contact sales".
2. Removed the CTA button row ("Try The Record free" / "Watch demo") and the "Trusted by teams at" fictional-logo row from the hero's left column.
3. Removed the "Try The Record free" button from the top-right nav, leaving only "Log in".

Net effect: the landing page is now much more login-focused than marketing-focused — the nav is just logo + Log in, and the hero left column is headline + subheading with no secondary CTAs.

## Tokens (unified into the single app-wide Tailwind theme, `src/index.css`)
- `--color-accent: #3457D5` (the dashboard's blue was chosen as the single app-wide accent instead of maintaining the spec's slightly different landing-page blue `#2F5CE0`, for cross-page consistency).
- `--color-page / --color-card / --color-border`, `--color-ink / --color-muted / --color-lmuted`, `--color-green` (unused on this page — no positive/on-track signals live here).
- `--font-display: Space Grotesk` (headline, wordmark), `--font-sans: Inter` (everything else).

## Layout
- Nav: `flex justify-between`, logo left, Log in right (was logo / center links / right actions before trimming).
- Hero: `grid grid-cols-[60%_40%]`, 60/40 split, left column text, right column floating login card (`rounded-[18px]`, drop shadow — the only shadow on the page).
- Bottom strip: single full-width light-gray rounded card with avatar stack + usage-stats line.

## Open design issue
Removing the CTA row and trusted-by row left dead vertical space in the hero's left column (visible below the subheading in the current layout). Not yet resolved — options are: increase headline/subheading font size, vertically center the column's content against the login card's height, or reintroduce a single lighter-weight element (e.g. just the trusted-by row without the buttons) to fill the gap.

## Accessibility
All interactive elements (`Log in`, SSO buttons, checkbox, submit) carry `focus-visible:outline focus-visible:outline-2 outline-accent`, per the original spec's accessibility requirement.

## Login/signup mode toggle (added with real auth)
When real auth was wired up, the single login card became dual-purpose: a `mode` toggle (`'login' | 'signup'`) swaps the heading, subheading, and submit label, and conditionally shows a "Full name" field in signup mode. No new visual variant was explored for this — it reuses the exact same card styling, just with conditional fields, to avoid introducing a second design surface for what's fundamentally the same form.

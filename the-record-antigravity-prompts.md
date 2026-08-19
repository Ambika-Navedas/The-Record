# The Record — Build Prompts for Antigravity

Two standalone prompts below. Each is self-contained — paste one at a time into Antigravity as a fresh build instruction.

---

## PROMPT 1 — Login / Landing Page

Build a single-page marketing + login screen for a B2B SaaS product called **"The Record"** — a centralized knowledge platform for organizations (projects, documents, meeting notes, decisions, and an AI chatbot that answers questions from that knowledge, all in one place).

**Layout — top to bottom:**

1. **Nav bar** (full width, bottom border, ~20px vertical padding, 40px horizontal padding):
   - Left: logo mark (a simple angular "mountain peak" SVG line icon, single color) + wordmark "The Record", bold, ~18px.
   - Center-left: text nav links with dropdown carets — "Product ⌄", "Solutions ⌄", "Resources ⌄", "Pricing" — muted gray, 14px, hover to dark.
   - Right-aligned: "Contact sales" text link, an outlined "Log in" button, and a filled dark "Try The Record free" button.

2. **Hero section** — two-column grid (roughly 60/40 split), generous padding (~70px top, 60px sides):
   - **Left column:**
     - Small pill-shaped eyebrow tag above the headline: "Now syncing with Zoom" — blue text on pale blue background.
     - Large bold headline, two lines, tight line-height, letter-spacing slightly negative: "One workspace. / Every answer." — where "answer." is colored in the accent blue and the rest is near-black.
     - Subheading paragraph below (max-width ~440px, muted gray): "Projects, docs, meetings, and decisions — all in one searchable home. Ask The Record a question and get an answer with sources, not a folder to dig through."
     - Two CTA buttons side by side: a solid dark "Try The Record free" button, and a ghost/outlined "Watch demo" button.
     - Below that, a "Trusted by teams at" label (small caps, muted) followed by a row of 5 fictional company wordmarks in a light gray, bold serif-ish font (do NOT use real company names): "Northwind", "Fenwick & Co", "Atlas Robotics", "Vantix", "Cornerhill".
   - **Right column:** a floating white login card with soft drop shadow and rounded corners (~18px radius), containing:
     - Title: "Log in to The Record", subtitle: "Welcome back — pick up where your team left off."
     - Two full-width SSO buttons stacked: "Continue with Google" (with a real 4-color Google 'G' icon) and "Continue with SSO" (with a simple browser/building icon).
     - A horizontal divider with the text "or continue with email" centered in it.
     - Email input labeled "Work email" (placeholder: you@yourcompany.com).
     - Password input labeled "Password" (placeholder: dots).
     - A row with a "Stay signed in" checkbox on the left and a "Forgot password?" link (blue) on the right.
     - A full-width solid blue "Log in" submit button.
     - Footer line, centered: "Don't have an account? Sign up" (Sign up is a blue link).

3. **Bottom strip** — a single full-width light-gray rounded card below the hero, containing a small stack of 3 overlapping circular avatars (colored, initials) and a line of text: "312 knowledge items and 48 meetings are already searchable across [Company Name] — jump back in."

**Design tokens:**
- Background: white (#FFFFFF); secondary surface: very light gray (#F7F7F9); borders: #EAEAEE.
- Text: near-black ink (#1B1C22); muted gray (#6B6C76).
- Single accent: blue (#2F5CE0), with a pale blue tint (#EDF1FD) for the eyebrow pill background.
- Fonts: "Space Grotesk" (600/700 weight) for the wordmark and headline; "Inter" (400–800 weight) for everything else — load both from Google Fonts.
- Buttons: 8–9px border radius. Cards: 16–18px border radius. Generous whitespace, no drop shadows except on the floating login card.
- Fully responsive is a bonus but not required — desktop-first, roughly 1280px max content width, centered.

---

## PROMPT 2 — Home Dashboard ("Layout 1")

Build the logged-in home/dashboard screen for the same product, **"The Record"**. Style: calm, mostly-neutral SaaS dashboard with exactly **one accent color** (blue) — avoid using more than two colors total anywhere on the page (blue for accent/action, a small muted green only for "positive/on-track" signals). No dark-mode cards, no multi-color widgets — everything is a plain white card on a very light gray page background.

**Layout — top to bottom:**

1. **Top bar** (white, bottom border, ~20px vertical / 34px horizontal padding):
   - Left: logo icon + wordmark "The Record" (bold, Space Grotesk).
   - Next to it: a search input styled like a search bar (magnifying glass icon + placeholder text "Search projects, docs, meetings…"), ~300px wide, light gray background, subtle border, positioned with a left margin so it sits apart from the logo.
   - Right-aligned group: a solid blue **"+ New project"** button (plus icon + label), a square notification bell icon button (white bg, border), and a stack of 3 small overlapping circular avatars (colored, white initials) representing people currently online.

2. **Page heading** (below top bar, left-aligned, modest padding):
   - Large bold title: "Good morning, [Name]"
   - Muted gray subtitle below it: "Here's what's moving across [Organization] this week."

3. **"Your projects" row** — a horizontally scrollable row of cards:
   - Section label "YOUR PROJECTS" (small caps, muted, bold) on the left, "See all →" link (blue) on the right, same row.
   - 4 project cards, each ~196px wide, white background, bordered, rounded corners (~12px), containing: a small status dot (blue-green if "on track", gray if not) + project name (bold), a muted meta line ("62 docs · updated 2h ago"), and — the important part — an explicit status word underneath in small text ("On track" in green, or "Needs attention" / "Blocked" in muted gray). Don't rely on the dot color alone to convey status; always pair it with text.
   - A 5th tile styled as a dashed-border "add" button: a circular "+" icon and the label "New project", which highlights blue on hover.

4. **Bento grid of 5 cards below**, arranged in a grid: one smaller card top-left, one wide card top-right (spanning 2 columns), then 3 even cards in a row below. All cards are plain white, bordered, ~16px radius, ~20px padding. Specifically:

   - **Card A — "Knowledge health"** (top-left, narrow): subtitle "Freshness across all projects" in muted small text next to the title, a small green "+6%" pill top-right. Below: a mini bar-chart row (7 thin vertical bars of varying height, alternating muted-gray and blue) with no axis labels. Below that, two side-by-side stat boxes on a light gray background: "82% / Freshness score" and "3.2d / Avg. review time".

   - **Card B — "Documents by type"** (top-right, wide, spans 2 columns): subtitle "312 items across 6 projects", a green "+12% this month" pill top-right. Below: 4 horizontal rows, each with a label on the left ("SOPs", "Meetings", "Decisions", "FAQs"), a horizontal progress-bar track in the middle (blue fill, decreasing opacity for each row: 100%, 80%, 60%, 40%), and a bold percentage on the right (38%, 27%, 21%, 14%).

   - **Card C — "Ask The Record"** (bottom-left, narrow): a small rounded square icon badge (pale blue background, blue chat-bubble icon) at the top. Below: bold headline "Ask The Record anything. Get answers with sources." and a muted description sentence: "Every project, doc, and meeting transcript — searched instantly, cited honestly." At the bottom: a fake input-style element (light gray background, bordered, rounded) containing example text: 💬 "Who owns the rollback runbook?" with a small blue arrow/send icon on the right edge to make it look clickable.

   - **Card D — "Questions answered"** (bottom-middle, narrow): subtitle "This week". Below: a large bold number "182/190" (the "/190" part in smaller muted text), then a muted line "96% resolved without escalation". Below that, centered, an SVG circular progress ring (gray track, blue progress arc at ~96%) with the number **"96%" printed in the center of the ring** — don't leave the ring empty.

   - **Card E — "This month"** (bottom-right, narrow): subtitle "Meeting sync activity · August". Two small stat pairs side by side at the top: "21 / Days active" and "48 / Synced". Below: a row of 7 single-letter weekday headers (S M T W T F S) in small muted text, then a 7-column grid of small circles (3 rows, i.e. a partial calendar) — filled blue for days with synced meetings, outlined gray for days without. At the bottom: a small stack of overlapping circular avatars representing attendees, plus a "+4" overflow circle.

**Design tokens:**
- Page background: very light gray (#F7F8FA). Cards: white (#FFFFFF), 1px border (#E7E8ED).
- Text: near-black (#1B1C22); muted gray (#71727C); lighter muted (#A3A4AD).
- Single accent: blue (#3457D5), pale blue tint (#EBF0FE) for icon badges/backgrounds.
- Secondary signal color (used sparingly, only for "good/positive" indicators): green (#2FA97A), pale green tint (#E6F5EF).
- Fonts: "Space Grotesk" (600/700) for headings/numbers/wordmark, "Inter" (400–700) for everything else — load both from Google Fonts.
- Border radius: ~9–12px on buttons/inputs, ~12–16px on cards, full circle on avatars.
- Accessibility: give all interactive elements (buttons, the add-project tile, the search bar) a visible focus outline in the accent blue for keyboard navigation.
- Responsiveness: at ≤900px width, collapse the bento grid to 2 columns (stack the "This month" card full-width on its own row); at ≤620px, collapse to a single column and hide the search bar.

**Tone:** calm, uncluttered, "one thing to look at at a time." Nothing should compete visually with the blue accent — if in doubt, make it gray instead of a new color.

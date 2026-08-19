import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Shared by meetings.ts (manual uploads) and integrations.ts (Zoom recording sync) — both
// write into the same server/uploads/<meetingId>/ tree, so this lives in one place rather
// than being computed twice with duplicated relative-path math.
export const UPLOADS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Loads ZOOM_CLIENT_ID/SECRET and GOOGLE_CLIENT_ID/SECRET for the integrations router
// (see server/.env.example) — optional, so a missing .env just leaves those unconfigured
// rather than crashing the server. Must run before importing app.ts, since app.ts's own
// imports (db.ts etc.) read process.env at their own top level — see db.ts's comment for the
// full ESM-import-hoisting explanation this same pattern works around everywhere else.
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

const { app } = await import('./app.ts')

// Local dev / any traditional long-running host (Railway, Render, a VPS) — not used on Vercel,
// which imports app.ts directly via api/index.ts instead and never runs this file at all.
const PORT = 4000
app.listen(PORT, () => {
  console.log(`The Record API listening on http://localhost:${PORT}`)
})

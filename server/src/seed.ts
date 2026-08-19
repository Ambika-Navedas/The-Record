import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { pool } from './db.ts'

// Only ensures the org + users exist (upserted by natural key, never re-created) so that
// re-running the seed script never invalidates an existing browser session. See
// docs/use-cases/landing-login/backend.md for why this matters.
//
// This used to also generate a full set of hardcoded demo projects/meetings/knowledge docs
// on every run — that content (and every real row created since, including test data from
// development) was removed on request. Content tables are left alone here; the app now
// starts empty and is populated only through real use (manual creation, or Zoom/Google
// Meet/Gmail sync).

async function getOrCreateOrg(name: string, domain: string): Promise<string> {
  const existing = (await pool.query('SELECT id FROM organizations WHERE domain = $1', [domain])).rows[0] as
    | { id: string }
    | undefined
  if (existing) return existing.id
  const id = randomUUID()
  await pool.query('INSERT INTO organizations (id, name, domain) VALUES ($1, $2, $3)', [id, name, domain])
  return id
}

async function makeUser(orgId: string, name: string, initials: string, email: string) {
  const existing = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0] as
    | { id: string }
    | undefined
  if (existing) return existing.id
  const id = randomUUID()
  const passwordHash = bcrypt.hashSync('password123', 10)
  await pool.query('INSERT INTO users (id, org_id, email, password_hash, name, initials) VALUES ($1, $2, $3, $4, $5, $6)', [
    id,
    orgId,
    email,
    passwordHash,
    name,
    initials,
  ])
  return id
}

async function main() {
  const orgId = await getOrCreateOrg('Navedas', 'navedas.com')
  await makeUser(orgId, 'Ambika', 'A', 'ambika@navedas.com')
  console.log('Ensured Navedas org + Ambika exist. Content tables left untouched — nothing else seeded.')
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

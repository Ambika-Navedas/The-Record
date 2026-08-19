import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pool } from './db.ts'
import { UPLOADS_ROOT } from './uploadsPath.ts'

// Three backends, in priority order — same "optional external service, behavior depends on
// what's configured" shape already used for Neo4j (graph.ts) and Gemini (chatAgent.ts):
//   1. Vercel Blob, if BLOB_READ_WRITE_TOKEN is set (added via the project's Storage tab).
//   2. Postgres (file_blobs table, db.ts), if FILE_STORAGE=postgres is set explicitly — the
//      alternative for a deploy with no persistent disk and no separate blob store. Real
//      tradeoff, not a free lunch: large blobs in Postgres bloat the WAL and cost more to store
//      and query than they would in Blob or on disk — fine for avatars/project docs (a few MB),
//      a genuinely bad fit for meeting recordings (up to 200MB). Chosen anyway, deliberately, to
//      avoid a second external dependency beyond Neon, which this app already requires.
//   3. Local disk (default) — local dev, or any host with a real persistent filesystem
//      (Railway, Render, a VPS). Not inferred from the environment; each mode is opt-in via its
//      own env var so local dev never accidentally starts hitting the database for every avatar
//      swap during testing.
//
// storage_path stays a single TEXT column throughout (no schema change beyond the new
// file_blobs table) — it holds a relative local path, a full Blob URL, or 'db:<file_blobs.id>',
// and isRemoteUrl()/isDbBlob() below is how every read/serve site tells which one it's looking at.
function useBlob(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN
}

function usePostgres(): boolean {
  return process.env.FILE_STORAGE === 'postgres'
}

export function isRemoteUrl(storagePath: string): boolean {
  return storagePath.startsWith('http://') || storagePath.startsWith('https://')
}

export function isDbBlob(storagePath: string): boolean {
  return storagePath.startsWith('db:')
}

// subpath/filename mirrors the existing local directory convention (e.g. 'avatars/<userId>',
// 'meetings/<meetingId>') so all three backends stay organized the same way, even though
// Postgres/Blob don't have real directories — it's just part of the object key/blob id.
export async function saveFile(buffer: Buffer, subpath: string, filename: string, contentType?: string): Promise<string> {
  if (useBlob()) {
    const { put } = await import('@vercel/blob')
    const blob = await put(`${subpath}/${filename}`, buffer, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
    })
    return blob.url
  }
  if (usePostgres()) {
    const id = randomUUID()
    await pool.query('INSERT INTO file_blobs (id, data, mime_type) VALUES ($1, $2, $3)', [
      id,
      buffer,
      contentType ?? 'application/octet-stream',
    ])
    return `db:${id}`
  }
  const dir = path.join(UPLOADS_ROOT, subpath)
  mkdirSync(dir, { recursive: true })
  const relativePath = path.join(subpath, filename)
  writeFileSync(path.join(UPLOADS_ROOT, relativePath), buffer)
  return relativePath
}

// Best-effort, same tolerance as graph.ts's writes — a failed delete here shouldn't block the
// Postgres row deletion it's cleaning up after.
export async function deleteFile(storagePath: string): Promise<void> {
  if (isDbBlob(storagePath)) {
    await pool.query('DELETE FROM file_blobs WHERE id = $1', [storagePath.slice(3)]).catch((err) => {
      console.error('file_blobs delete failed', err)
    })
    return
  }
  if (isRemoteUrl(storagePath)) {
    if (useBlob()) {
      const { del } = await import('@vercel/blob')
      await del(storagePath).catch((err) => console.error('Blob delete failed', err))
    }
    return
  }
  const filePath = path.join(UPLOADS_ROOT, storagePath)
  if (existsSync(filePath)) unlinkSync(filePath)
}

// Resolves a stored path to an absolute local filesystem path — callers must check
// isRemoteUrl()/isDbBlob() first and redirect/readDbBlob instead of calling this otherwise.
export function localFilePath(storagePath: string): string {
  return path.join(UPLOADS_ROOT, storagePath)
}

// Callers must check isDbBlob() first — throws if storagePath isn't actually a 'db:' reference.
export async function readDbBlob(storagePath: string): Promise<{ data: Buffer; mimeType: string }> {
  const id = storagePath.slice(3)
  const { rows } = await pool.query('SELECT data, mime_type FROM file_blobs WHERE id = $1', [id])
  const row = rows[0] as { data: Buffer; mime_type: string } | undefined
  if (!row) throw new Error(`file_blobs row not found for id ${id}`)
  return { data: row.data, mimeType: row.mime_type }
}

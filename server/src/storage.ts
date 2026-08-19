import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { UPLOADS_ROOT } from './uploadsPath.ts'

// Vercel's serverless filesystem is ephemeral and read-only outside /tmp, and /tmp itself is
// wiped between invocations — writing to local disk (this file's fallback) only works for local
// dev and for hosts with a real persistent filesystem (Railway, Render, a VPS). On Vercel, set
// BLOB_READ_WRITE_TOKEN (from adding Vercel Blob to the project) and every save below switches
// to that automatically — same "optional external service, behavior depends on what's
// configured" shape already used for Neo4j (graph.ts) and Gemini (chatAgent.ts).
//
// storage_path stays a single TEXT column either way (no schema change) — it just holds either
// a relative local path ('avatars/<userId>/<file>') or a full Blob URL ('https://...blob...'),
// and isRemoteUrl() below is how every read/serve site tells which one it's looking at.
function useBlob(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN
}

export function isRemoteUrl(storagePath: string): boolean {
  return storagePath.startsWith('http://') || storagePath.startsWith('https://')
}

// subpath/filename mirrors the existing local directory convention (e.g. 'avatars/<userId>',
// 'meetings/<meetingId>') so the two backends stay organized the same way.
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
  const dir = path.join(UPLOADS_ROOT, subpath)
  mkdirSync(dir, { recursive: true })
  const relativePath = path.join(subpath, filename)
  writeFileSync(path.join(UPLOADS_ROOT, relativePath), buffer)
  return relativePath
}

// Best-effort, same tolerance as graph.ts's writes — a failed delete here shouldn't block the
// Postgres row deletion it's cleaning up after.
export async function deleteFile(storagePath: string): Promise<void> {
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
// isRemoteUrl() first and redirect instead of calling this for a Blob-backed file.
export function localFilePath(storagePath: string): string {
  return path.join(UPLOADS_ROOT, storagePath)
}

// VITE_API_BASE_URL is a build-time env var (Vercel project settings, or app/.env.local for a
// custom local override) — falls back to the local dev server so nothing changes for anyone
// running `npm run dev` without setting it. Was hardcoded to localhost before this, which meant
// every deployed build silently tried to call the developer's own machine.
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(res.status, body.error ?? res.statusText)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  // No 'Content-Type' header here — the browser sets the multipart boundary itself for FormData.
  upload: async <T>(path: string, formData: FormData): Promise<T> => {
    const res = await fetch(`${API_BASE}${path}`, { method: 'POST', credentials: 'include', body: formData })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new ApiError(res.status, body.error ?? res.statusText)
    }
    return res.json() as Promise<T>
  },
}

export const API_BASE_URL = API_BASE

// ---- Types shared with the backend response shapes ----

export interface AuthedUser {
  id: string
  org_id: string
  org_name: string
  email: string
  name: string
  initials: string
  role: 'admin' | 'member'
  designation: string
  department: string
  employee_id: string
  avatar_url: string | null
}

export interface TeamRoleItem {
  id: string
  name: string
  email: string
  role: 'admin' | 'member'
  active: boolean
}

export interface TeamMemberProfile {
  id: string
  name: string
  email: string
  initials: string
  role: 'admin' | 'member'
  designation: string
  department: string
  employeeId: string
  avatarUrl: string | null
  active: boolean
}

export interface ProjectItem {
  id: string
  name: string
  description: string
  status: 'on_track' | 'attention' | 'blocked'
  updatedAt: string
  owner: { id: string; name: string; initials: string }
  docCount: number
  meetingCount: number
  gitUrl: string
  deploymentUrl: string
  username: string
  password: string
}

export interface ProjectsResponse {
  items: ProjectItem[]
  counts: Record<string, number>
}

export interface OrgUser {
  id: string
  name: string
  initials: string
}

export interface InviteUserResult {
  id: string
  email: string
  name: string
  initials: string
  temporaryPassword: string
}

export interface ParticipantDescriptor {
  userId: string | null
  name: string
  initials: string | null
  email: string | null
}

export interface MeetingItem {
  id: string
  title: string
  summary: string
  participants: ParticipantDescriptor[]
  scheduledAt: string
  durationMin: number
  syncStatus: 'synced' | 'processing' | 'failed'
  source: 'zoom' | 'google_meet' | 'manual_upload' | 'other'
  project: string | null
}

export interface MeetingAsset {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  uploadedBy: { id: string; name: string }
  createdAt: string
}

export interface MeetingTask {
  id: string
  title: string
  assignee: { id: string; name: string; initials: string } | null
  dueDate: string | null
  done: boolean
  completionNote: string | null
  createdAt: string
}

export interface MeetingDetail extends MeetingItem {
  assets: MeetingAsset[]
  tasks: MeetingTask[]
}

export interface IntegrationStatus {
  configured: boolean
  connected: boolean
  connectedAt: string | null
}

export interface GmailStatus extends IntegrationStatus {
  query: string
}

export interface IntegrationsResponse {
  zoom: IntegrationStatus
  google: IntegrationStatus
  gmail: GmailStatus
}

export interface SyncResult {
  results: Record<string, { imported: number; recordingsImported: number; error: string | null }>
}

export interface GmailSyncResult {
  imported: number
}

export interface KnowledgeDocItem {
  id: string
  type: 'sop' | 'meeting_note' | 'decision' | 'faq' | 'email' | 'file'
  title: string
  excerpt: string
  updatedAt: string
  deletedAt: string | null
  isFresh: boolean
  owner: string
  project: string | null
  hasFile: boolean
  fileName: string | null
  sizeBytes: number | null
}

export interface DashboardSummary {
  user: { name: string }
  org: { name: string }
  projects: { id: string; name: string; status: string; updatedAt: string; docCount: number; owner: { name: string; initials: string } }[]
  taskOverview: {
    totalItems: number
    completionRatePct: number
    overdueCount: number
    breakdown: { status: 'open' | 'overdue' | 'done'; count: number; pct: number }[]
    byAssignee: { id: string; name: string; initials: string; total: number; doneCount: number; overdueCount: number; completionRatePct: number }[]
  }
  documentsByType: { totalItems: number; breakdown: { type: string; pct: number }[] }
  upcomingHolidays: { date: string; name: string }[]
  nextEvent: { id: string; title: string; project: string | null; scheduledAt: string; durationMin: number } | null
  todaysMeetingUpdate: {
    id: string
    title: string
    summary: string
    project: string | null
    scheduledAt: string
    syncStatus: string
  } | null
  mostPopularContent: { id: string; title: string; type: string; project: string | null; viewCount: number } | null
}

export interface TaskCalendarDay {
  date: string
  byAssignee: { id: string; name: string; initials: string; count: number }[]
}

export interface LeaveCalendarDay {
  date: string
  people: { id: string; name: string; initials: string; leaveTypeName: string }[]
}

export interface ChatAnswer {
  answerText: string
  sources: { id: string; title: string; type: string; project: string | null; via: 'keyword' | 'graph' }[]
}

export interface TaskItem {
  id: string
  meetingId: string
  meetingTitle: string
  meetingScheduledAt: string
  title: string
  assignee: { id: string; name: string; initials: string } | null
  dueDate: string | null
  done: boolean
  completionNote: string | null
  createdAt: string
}

export interface TasksResponse {
  items: TaskItem[]
  counts: { all: number; open: number; done: number }
}

export interface Holiday {
  id: string
  date: string
  name: string
  isOptional: boolean
  selectedByMe: boolean
}

export interface LeaveType {
  id: string
  name: string
}

export interface LeaveBalance {
  leaveTypeId: string
  name: string
  balance: number
}

export interface TeamMemberBalances {
  userId: string
  userName: string
  employeeId: string
  balances: LeaveBalance[]
}

export interface LeaveRequest {
  id: string
  userId: string
  userName: string
  leaveTypeId: string
  leaveTypeName: string
  fromDate: string
  toDate: string
  days: number
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  reviewerName: string | null
  reviewedAt: string | null
  createdAt: string
}

export interface OnLeaveEntry {
  userId: string
  userName: string
  userInitials: string
  leaveTypeName: string
  fromDate: string
  toDate: string
  days: number
}

export interface TaskActivityEntry {
  id: string
  action: 'assigned' | 'done' | 'reopened'
  actorName: string
  assigneeName: string | null
  reason: string | null
  createdAt: string
}

export interface SearchResponse {
  projects: { id: string; name: string; status: string }[]
  meetings: { id: string; title: string; scheduledAt: string }[]
  documents: { id: string; title: string; type: string }[]
}

export interface NotificationItem {
  id: string
  message: string
  read: boolean
  createdAt: string
}

export interface ReminderItem {
  id: string
  text: string
  dueAt: string | null
  createdAt: string
}

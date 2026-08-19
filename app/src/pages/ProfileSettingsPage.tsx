import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { api, ApiError, API_BASE_URL, type AuthedUser } from '../lib/api'

export function ProfileSettingsPage() {
  const { user, updateUser } = useAuth()

  const [name, setName] = useState(user?.name ?? '')
  const [designation, setDesignation] = useState(user?.designation ?? '')
  const [department, setDepartment] = useState(user?.department ?? '')
  const [employeeId, setEmployeeId] = useState(user?.employee_id ?? '')
  const [savingDetails, setSavingDetails] = useState(false)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [detailsSaved, setDetailsSaved] = useState(false)

  const [avatarUploading, setAvatarUploading] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [avatarBust, setAvatarBust] = useState(0)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordSaved, setPasswordSaved] = useState(false)

  if (!user) return null

  const detailsUnchanged =
    name.trim() === user.name &&
    designation.trim() === user.designation &&
    department.trim() === user.department &&
    employeeId.trim() === user.employee_id

  async function handleSaveDetails(e: FormEvent) {
    e.preventDefault()
    setDetailsError(null)
    setDetailsSaved(false)
    if (!name.trim()) {
      setDetailsError('Full name cannot be empty.')
      return
    }
    setSavingDetails(true)
    try {
      const updated = await api.patch<AuthedUser>('/auth/me', {
        name: name.trim(),
        designation: designation.trim(),
        department: department.trim(),
        employeeId: employeeId.trim(),
      })
      updateUser(updated)
      setDetailsSaved(true)
    } catch (err) {
      setDetailsError(err instanceof ApiError ? err.message : 'Could not save your details.')
    } finally {
      setSavingDetails(false)
    }
  }

  async function handleAvatarChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setAvatarError(null)
    setAvatarUploading(true)
    try {
      const formData = new FormData()
      formData.append('avatar', file)
      const updated = await api.upload<AuthedUser>('/auth/me/avatar', formData)
      updateUser(updated)
      setAvatarBust((b) => b + 1)
    } catch (err) {
      setAvatarError(err instanceof ApiError ? err.message : 'Could not upload that photo.')
    } finally {
      setAvatarUploading(false)
    }
  }

  async function handleRemoveAvatar() {
    setAvatarError(null)
    try {
      const updated = await api.delete<AuthedUser>('/auth/me/avatar')
      updateUser(updated)
      setAvatarBust((b) => b + 1)
    } catch (err) {
      setAvatarError(err instanceof ApiError ? err.message : 'Could not remove your photo.')
    }
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault()
    setPasswordError(null)
    setPasswordSaved(false)
    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirmation do not match.')
      return
    }
    setSavingPassword(true)
    try {
      const updated = await api.patch<AuthedUser>('/auth/me', { currentPassword, newPassword })
      updateUser(updated)
      setPasswordSaved(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setPasswordError(err instanceof ApiError ? err.message : 'Could not change your password.')
    } finally {
      setSavingPassword(false)
    }
  }

  const avatarSrc = user.avatar_url ? `${API_BASE_URL}${user.avatar_url}?v=${avatarBust}` : null

  return (
    <>
      <div className="mb-7">
        <h1 className="font-display text-[28px] font-bold">Profile settings</h1>
        <p className="mt-1 text-sm text-muted">Manage your profile, HR details, and password.</p>
      </div>

      <div className="grid grid-cols-2 items-start gap-5">
        <div className="flex flex-col gap-5">
          <form onSubmit={handleSaveDetails} className="rounded-2xl border border-border bg-card p-5">
            <h2 className="mb-3 font-display text-base font-bold">Personal details</h2>
            <label className="mb-1.5 block text-[13px] font-semibold text-muted">Email</label>
            <div className="mb-3.5 rounded-lg border border-border bg-page px-3 py-2.5 text-sm text-muted">{user.email}</div>
            <label className="mb-1.5 block text-[13px] font-semibold text-muted">Full name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mb-3.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            <label className="mb-1.5 block text-[13px] font-semibold text-muted">Designation</label>
            <input
              value={designation}
              onChange={(e) => setDesignation(e.target.value)}
              placeholder="e.g. Senior Product Manager"
              className="mb-3.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            <label className="mb-1.5 block text-[13px] font-semibold text-muted">Department / Team</label>
            <input
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              placeholder="e.g. Engineering"
              className="mb-3.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            <label className="mb-1.5 block text-[13px] font-semibold text-muted">Employee ID</label>
            <input
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              placeholder="e.g. NV-0142"
              className="mb-3.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            {detailsError && (
              <div className="mb-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{detailsError}</div>
            )}
            {detailsSaved && (
              <div className="mb-3.5 rounded-lg bg-green-50 px-3 py-2 text-[13px] text-green-700">Saved.</div>
            )}
            <button
              type="submit"
              disabled={savingDetails || !name.trim() || detailsUnchanged}
              className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {savingDetails ? 'Saving…' : 'Save details'}
            </button>
          </form>
        </div>

        <div className="flex flex-col gap-5">
          <div className="rounded-2xl border border-border bg-card p-5">
            <h2 className="mb-3 font-display text-base font-bold">Profile picture</h2>
            <div className="flex items-center gap-4">
              {avatarSrc ? (
                <img
                  src={avatarSrc}
                  alt={user.name}
                  className="h-16 w-16 rounded-full border border-border object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#4B4C58] text-lg font-bold text-white">
                  {user.initials}
                </div>
              )}
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={avatarUploading}
                    className="rounded-lg border border-border bg-white px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-page disabled:opacity-60"
                  >
                    {avatarUploading ? 'Uploading…' : avatarSrc ? 'Change photo' : 'Upload photo'}
                  </button>
                  {avatarSrc && (
                    <button
                      type="button"
                      onClick={handleRemoveAvatar}
                      className="rounded-lg border border-border bg-white px-3 py-1.5 text-[13px] font-semibold text-red-700 hover:bg-red-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarChange}
                  className="hidden"
                />
                {avatarError && <div className="text-[13px] text-red-700">{avatarError}</div>}
              </div>
            </div>
          </div>

          <form onSubmit={handleChangePassword} className="rounded-2xl border border-border bg-card p-5">
            <h2 className="mb-3 font-display text-base font-bold">Change password</h2>
            <label className="mb-1.5 block text-[13px] font-semibold text-muted">Current password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="mb-3.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            <label className="mb-1.5 block text-[13px] font-semibold text-muted">New password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="mb-3.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            <label className="mb-1.5 block text-[13px] font-semibold text-muted">Confirm new password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="mb-3.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            {passwordError && (
              <div className="mb-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{passwordError}</div>
            )}
            {passwordSaved && (
              <div className="mb-3.5 rounded-lg bg-green-50 px-3 py-2 text-[13px] text-green-700">Password changed.</div>
            )}
            <button
              type="submit"
              disabled={savingPassword || !currentPassword || !newPassword || !confirmPassword}
              className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {savingPassword ? 'Saving…' : 'Change password'}
            </button>
          </form>
        </div>
      </div>
    </>
  )
}

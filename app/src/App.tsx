import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { AuthProvider } from './context/AuthContext'
import { LandingPage } from './pages/LandingPage'
import { DashboardPage } from './pages/DashboardPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { MeetingsPage } from './pages/MeetingsPage'
import { MeetingDetailPage } from './pages/MeetingDetailPage'
import { KnowledgePage } from './pages/KnowledgePage'
import { KnowledgeDetailPage } from './pages/KnowledgeDetailPage'
import { KnowledgeTrashPage } from './pages/KnowledgeTrashPage'
import { TasksPage } from './pages/TasksPage'
import { ProfileSettingsPage } from './pages/ProfileSettingsPage'
import { HolidaysPage } from './pages/HolidaysPage'
import { WorkNestPage } from './pages/WorkNestPage'
import { RemindersPage } from './pages/RemindersPage'
import { TeamRolesPage } from './pages/TeamRolesPage'

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/app" element={<AppLayout />}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="meetings" element={<MeetingsPage />} />
          <Route path="meetings/:id" element={<MeetingDetailPage />} />
          <Route path="knowledge" element={<KnowledgePage />} />
          <Route path="knowledge/trash" element={<KnowledgeTrashPage />} />
          <Route path="knowledge/:id" element={<KnowledgeDetailPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="profile" element={<ProfileSettingsPage />} />
          <Route path="holidays" element={<HolidaysPage />} />
          <Route path="worknest" element={<WorkNestPage />} />
          <Route path="reminders" element={<RemindersPage />} />
          <Route path="team-roles" element={<TeamRolesPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  )
}

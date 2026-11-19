import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { PageLayout } from './components/layout/PageLayout';
import { ProtectedRoute } from './components/layout/ProtectedRoute';
import { AuthProvider } from './context/AuthContext';
import { AboutPage } from './pages/AboutPage';
import { AchievementsPage } from './pages/AchievementsPage';
import { AdminAnalyticsPage } from './pages/AdminAnalyticsPage';
import { AdminAuditLogsPage } from './pages/AdminAuditLogsPage';
import { AdminDashboardPage } from './pages/AdminDashboardPage';
import { AdminSettingsPage } from './pages/AdminSettingsPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { ChallengeDetailPage } from './pages/ChallengeDetailPage';
import { ChallengeManagePage } from './pages/ChallengeManagePage';
import { ChallengesCatalogPage } from './pages/ChallengesCatalogPage';
import { CompetitionDetailPage } from './pages/CompetitionDetailPage';
import { CompetitionsListPage } from './pages/CompetitionsListPage';
import { ContactPage } from './pages/ContactPage';
import { DashboardPage } from './pages/DashboardPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { LandingPage } from './pages/LandingPage';
import { LeaderboardPage } from './pages/LeaderboardPage';
import { LoginPage } from './pages/LoginPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { ProfilePage } from './pages/ProfilePage';
import { RegisterPage } from './pages/RegisterPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { RulesPage } from './pages/RulesPage';
import { TeamDetailPage } from './pages/TeamDetailPage';
import { TeamsPage } from './pages/TeamsPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <PageLayout>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <DashboardPage />
                </ProtectedRoute>
              }
            />
            <Route path="/teams" element={<TeamsPage />} />
            <Route path="/teams/:slug" element={<TeamDetailPage />} />
            <Route path="/challenges" element={<ChallengesCatalogPage />} />
            <Route path="/challenges/:slug" element={<ChallengeDetailPage />} />
            <Route
              path="/admin/challenges"
              element={
                <ProtectedRoute>
                  <ChallengeManagePage />
                </ProtectedRoute>
              }
            />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/competitions" element={<CompetitionsListPage />} />
            <Route path="/competitions/:slug" element={<CompetitionDetailPage initialTab="overview" />} />
            <Route path="/competitions/:slug/rules" element={<CompetitionDetailPage initialTab="rules" />} />
            <Route path="/competitions/:slug/challenges" element={<CompetitionDetailPage initialTab="challenges" />} />
            <Route path="/competitions/:slug/leaderboard" element={<CompetitionDetailPage initialTab="leaderboard" />} />
            <Route path="/competitions/:slug/announcements" element={<CompetitionDetailPage initialTab="announcements" />} />
            <Route
              path="/notifications"
              element={
                <ProtectedRoute>
                  <NotificationsPage />
                </ProtectedRoute>
              }
            />
            <Route path="/achievements" element={<AchievementsPage />} />
            <Route path="/users/:username" element={<ProfilePage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/rules" element={<RulesPage />} />
            <Route path="/contact" element={<ContactPage />} />
            <Route
              path="/admin"
              element={
                <ProtectedRoute>
                  <AdminDashboardPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/users"
              element={
                <ProtectedRoute>
                  <AdminUsersPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/audit-logs"
              element={
                <ProtectedRoute>
                  <AdminAuditLogsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/analytics"
              element={
                <ProtectedRoute>
                  <AdminAnalyticsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/settings"
              element={
                <ProtectedRoute>
                  <AdminSettingsPage />
                </ProtectedRoute>
              }
            />
          </Routes>
        </PageLayout>
      </AuthProvider>
    </BrowserRouter>
  );
}

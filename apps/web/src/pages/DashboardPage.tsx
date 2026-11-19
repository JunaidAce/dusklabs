import { useEffect, useState } from 'react';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

interface DashboardSummary {
  totalPoints: number;
  solvedChallenges: number;
  unreadNotifications: number;
  team: {
    id: string;
    name: string;
    slug: string;
    role: string;
    memberCount: number;
  } | null;
  registeredCompetitions: Array<{
    id: string;
    slug: string;
    title: string;
    status: string;
    startsAt: string;
    endsAt: string;
  }>;
  recentActivity: Array<{
    id: string;
    challengeSlug: string;
    challengeTitle: string;
    pointsAwarded: number;
    isFirstBlood: boolean;
    solvedAt: string;
  }>;
}

export function DashboardPage() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<DashboardSummary>('/api/v1/dashboard/summary')
      .then((data) => {
        if (active) setSummary(data);
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof ApiClientError ? err.message : 'Failed to load dashboard');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div className="dl-label">OPERATOR CONSOLE</div>
        <h1 className="dl-section-title" style={{ marginBottom: '8px' }}>
          WELCOME, {user?.displayName.toUpperCase()}
        </h1>
        <div className="dl-label" style={{ marginBottom: '32px' }}>
          ROLES: {user?.roles.join(' · ')}
        </div>

        {error && <StatusBanner kind="error" message={error} />}

        {/* Real DB Metrics */}
        <div className="dl-grid dl-grid-4" style={{ marginBottom: '40px' }}>
          <Card>
            <div className="dl-label">TOTAL POINTS</div>
            <div className="dl-display-2" style={{ color: 'var(--color-gold)', marginTop: '8px' }}>
              {loading ? '—' : summary?.totalPoints ?? 0}
            </div>
          </Card>
          <Card>
            <div className="dl-label">SOLVED CHALLENGES</div>
            <div className="dl-display-2" style={{ marginTop: '8px' }}>
              {loading ? '—' : summary?.solvedChallenges ?? 0}
            </div>
          </Card>
          <Card>
            <div className="dl-label">ACTIVE COMPETITIONS</div>
            <div className="dl-display-2" style={{ marginTop: '8px' }}>
              {loading ? '—' : summary?.registeredCompetitions.length ?? 0}
            </div>
          </Card>
          <Card>
            <div className="dl-label">UNREAD NOTIFICATIONS</div>
            <div className="dl-display-2" style={{ marginTop: '8px' }}>
              {loading ? '—' : summary?.unreadNotifications ?? 0}
            </div>
          </Card>
        </div>

        {/* Team & Competitions */}
        <div className="dl-grid dl-grid-2">
          <div>
            <h2 className="dl-feature-title" style={{ marginBottom: '16px' }}>
              TEAM STATUS
            </h2>
            {!loading && !summary?.team ? (
              <EmptyState
                title="NO TEAM ASSIGNED"
                description="You are not currently on a team. Visit the Teams page to create a team or accept an invitation."
              />
            ) : (
              summary?.team && (
                <Card>
                  <span className="dl-badge dl-badge-gold">{summary.team.role}</span>
                  <h3 className="dl-feature-title" style={{ marginTop: '12px' }}>
                    {summary.team.name}
                  </h3>
                  <div className="dl-label" style={{ marginTop: '8px' }}>
                    MEMBERS: {summary.team.memberCount}
                  </div>
                </Card>
              )
            )}
          </div>

          <div>
            <h2 className="dl-feature-title" style={{ marginBottom: '16px' }}>
              RECENT SOLVES
            </h2>
            {!loading && (!summary || summary.recentActivity.length === 0) ? (
              <EmptyState
                title="NO SOLVES RECORDED"
                description="Validated flag submissions and first-blood awards will appear here in real time."
              />
            ) : (
              <Card>
                {summary?.recentActivity.map((act) => (
                  <div
                    key={act.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '12px 0',
                      borderBottom: '1px solid var(--border-hairline)',
                    }}
                  >
                    <div>
                      <div>{act.challengeTitle}</div>
                      <div className="dl-label">{new Date(act.solvedAt).toLocaleString()}</div>
                    </div>
                    <div style={{ color: 'var(--color-gold)' }}>+{act.pointsAwarded} PTS</div>
                  </div>
                ))}
              </Card>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

interface AdminOverviewResponse {
  metrics: {
    users: { total: number; active: number; suspended: number; banned: number };
    teams: { total: number };
    competitions: { total: number; live: number };
    challenges: { total: number; published: number };
    submissions: { total: number; valid: number; failed: number };
    moderation: {
      openReports: number;
      underReviewReports: number;
      openContactInquiries: number;
      totalPendingQueue: number;
    };
  };
  recentActivity: {
    solves: Array<{
      id: string;
      pointsAwarded: number;
      isFirstBlood: boolean;
      solvedAt: string;
      user: { username: string };
      team: { name: string } | null;
      challenge: { slug: string; title: string };
    }>;
    registrations: Array<{
      id: string;
      status: string;
      registeredAt: string;
      user: { username: string };
      competition: { slug: string; title: string };
    }>;
  };
  recentAuditEvents: Array<{
    id: string;
    action: string;
    entityType: string;
    entityId: string | null;
    actor: { username: string } | null;
    createdAt: string;
  }>;
  moderationQueuePreview: Array<{
    id: string;
    category: string;
    status: string;
    createdAt: string;
    reporter: { username: string };
    challenge: { title: string } | null;
    competition: { title: string } | null;
  }>;
}

export function AdminDashboardPage() {
  const { user } = useAuth();
  const canAccess =
    Boolean(user?.permissions.includes('audit:logs:read')) &&
    Boolean(user?.permissions.includes('user:manage'));

  const [data, setData] = useState<AdminOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<AdminOverviewResponse>('/api/v1/admin/overview');
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load admin overview');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canAccess) {
      void load();
    } else {
      setLoading(false);
    }
  }, [canAccess, load]);

  if (!canAccess) {
    return (
      <section className="dl-section" style={{ borderBottom: 'none' }}>
        <div className="dl-container">
          <StatusBanner
            kind="error"
            message="Authorization required: administrative overview permissions are missing."
          />
        </div>
      </section>
    );
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
            gap: '16px',
            marginBottom: '24px',
          }}
        >
          <div>
            <div className="dl-label">PLATFORM ADMINISTRATION · {user?.roles.join(' · ')}</div>
            <h1 className="dl-section-title">ADMIN DASHBOARD OVERVIEW</h1>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <LinkButton to="/admin/competitions" variant="ghost">
              MANAGE COMPETITIONS
            </LinkButton>
            <LinkButton to="/admin/challenges" variant="ghost">
              MANAGE CHALLENGES
            </LinkButton>
            <Button type="button" variant="gold" disabled={loading} onClick={() => void load()}>
              {loading ? 'REFRESHING...' : 'REFRESH TELEMETRY'}
            </Button>
          </div>
        </div>

        {error && <StatusBanner kind="error" message={error} />}

        {loading && !data ? (
          <div className="dl-label">QUERYING DATABASE TELEMETRY...</div>
        ) : !data ? (
          <EmptyState
            title="TELEMETRY UNAVAILABLE"
            description="No administrative metrics could be loaded."
          />
        ) : (
          <>
            {/* Primary KPI Grid */}
            <div className="dl-grid dl-grid-4" style={{ marginBottom: '24px' }}>
              <Card>
                <div className="dl-label">REGISTERED USERS</div>
                <div className="dl-display-2" style={{ color: 'var(--color-gold)', marginTop: '8px' }}>
                  {data.metrics.users.total}
                </div>
                <div className="dl-label" style={{ marginTop: '8px' }}>
                  ACTIVE: {data.metrics.users.active} · SUSPENDED: {data.metrics.users.suspended} · BANNED: {data.metrics.users.banned}
                </div>
              </Card>

              <Card>
                <div className="dl-label">COMPETITIONS</div>
                <div className="dl-display-2" style={{ marginTop: '8px' }}>
                  {data.metrics.competitions.total}
                </div>
                <div className="dl-label" style={{ marginTop: '8px', color: 'var(--color-gold)' }}>
                  CURRENTLY LIVE: {data.metrics.competitions.live}
                </div>
              </Card>

              <Card>
                <div className="dl-label">CHALLENGES &amp; TEAMS</div>
                <div className="dl-display-2" style={{ marginTop: '8px' }}>
                  {data.metrics.challenges.total}
                </div>
                <div className="dl-label" style={{ marginTop: '8px' }}>
                  PUBLISHED: {data.metrics.challenges.published} · TEAMS: {data.metrics.teams.total}
                </div>
              </Card>

              <Card>
                <div className="dl-label">SUBMISSIONS</div>
                <div className="dl-display-2" style={{ marginTop: '8px' }}>
                  {data.metrics.submissions.total}
                </div>
                <div className="dl-label" style={{ marginTop: '8px' }}>
                  VALID: {data.metrics.submissions.valid} · FAILED: {data.metrics.submissions.failed}
                </div>
              </Card>
            </div>

            {/* Moderation Queue Summary Banner */}
            <div
              style={{
                border:
                  data.metrics.moderation.totalPendingQueue > 0
                    ? '1px solid var(--color-gold)'
                    : '1px solid var(--border-hairline)',
                background: 'var(--surface-charcoal)',
                padding: '16px 24px',
                marginBottom: '32px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '12px',
              }}
            >
              <div>
                <div className="dl-label" style={{ color: 'var(--color-gold)' }}>
                  MODERATION QUEUE SUMMARY
                </div>
                <div style={{ marginTop: '4px' }}>
                  {data.metrics.moderation.totalPendingQueue} PENDING ITEMS · OPEN REPORTS:{' '}
                  {data.metrics.moderation.openReports} · UNDER REVIEW:{' '}
                  {data.metrics.moderation.underReviewReports} · OPEN CONTACT INQUIRIES:{' '}
                  {data.metrics.moderation.openContactInquiries}
                </div>
              </div>
            </div>

            {/* Activity, Audit & Queue Panels */}
            <div className="dl-grid dl-grid-2" style={{ alignItems: 'start' }}>
              <Card>
                <div className="dl-label" style={{ marginBottom: '12px' }}>
                  RECENT PLATFORM SOLVES
                </div>
                {data.recentActivity.solves.length === 0 ? (
                  <div className="dl-label">NO SOLVES RECORDED YET</div>
                ) : (
                  data.recentActivity.solves.map((s) => (
                    <div
                      key={s.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        padding: '10px 0',
                        borderBottom: '1px solid var(--border-hairline)',
                      }}
                    >
                      <div>
                        <div>
                          <strong>@{s.user.username}</strong>
                          {s.team ? ` (${s.team.name})` : ''} → {s.challenge.title}
                        </div>
                        <div className="dl-label">{new Date(s.solvedAt).toLocaleString()}</div>
                      </div>
                      <span style={{ color: 'var(--color-gold)' }}>+{s.pointsAwarded} PTS</span>
                    </div>
                  ))
                )}

                <div className="dl-label" style={{ marginTop: '24px', marginBottom: '12px' }}>
                  MODERATION QUEUE PREVIEW
                </div>
                {data.moderationQueuePreview.length === 0 ? (
                  <div className="dl-label">NO OPEN MODERATION REPORTS</div>
                ) : (
                  data.moderationQueuePreview.map((r) => (
                    <div
                      key={r.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        padding: '10px 0',
                        borderBottom: '1px solid var(--border-hairline)',
                      }}
                    >
                      <div>
                        <div>
                          {r.category} by @{r.reporter.username}
                        </div>
                        <div className="dl-label">
                          {r.challenge?.title ?? r.competition?.title ?? 'Platform'} ·{' '}
                          {new Date(r.createdAt).toLocaleString()}
                        </div>
                      </div>
                      <span className="dl-badge dl-badge-gold">{r.status}</span>
                    </div>
                  ))
                )}
              </Card>

              <Card>
                <div className="dl-label" style={{ marginBottom: '12px' }}>
                  RECENT AUDIT EVENTS
                </div>
                {data.recentAuditEvents.length === 0 ? (
                  <div className="dl-label">NO AUDIT EVENTS RECORDED</div>
                ) : (
                  data.recentAuditEvents.map((ev) => (
                    <div
                      key={ev.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: '12px',
                        padding: '10px 0',
                        borderBottom: '1px solid var(--border-hairline)',
                      }}
                    >
                      <div>
                        <div>
                          <strong>{ev.action}</strong>
                        </div>
                        <div className="dl-label">
                          {ev.entityType}
                          {ev.actor ? ` · BY @${ev.actor.username}` : ' · SYSTEM'}
                        </div>
                      </div>
                      <div className="dl-label" style={{ textAlign: 'right' }}>
                        {new Date(ev.createdAt).toLocaleString()}
                      </div>
                    </div>
                  ))
                )}
              </Card>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

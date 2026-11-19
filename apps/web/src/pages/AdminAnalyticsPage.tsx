import { useCallback, useEffect, useState } from 'react';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

interface PlatformAnalytics {
  scope: string;
  totals: {
    challenges: number;
    submissions: number;
    validSubmissions: number;
    failedSubmissions: number;
    overallSolveRatePercent: number;
  };
  mostSolvedChallenge: { slug: string; title: string; solveCount: number } | null;
  hardestChallenge: { slug: string; title: string; solveCount: number; attemptCount: number } | null;
  categoryPerformance: Array<{ slug: string; name: string; challengeCount: number; totalSolves: number }>;
  difficultyPerformance: Array<{ difficulty: string; challengeCount: number; totalSolves: number }>;
}

interface AdminCompOption {
  id: string;
  slug: string;
  title: string;
  status: string;
}

interface CompetitionAnalytics {
  competition: { id: string; slug: string; title: string; status: string };
  summary: {
    confirmedParticipants: number;
    confirmedTeams: number;
    activeParticipants: number;
    activeTeams: number;
    totalSubmissions: number;
    totalSolves: number;
  };
  challengeStats: Array<{
    id: string;
    slug: string;
    title: string;
    difficulty: string;
    points: number;
    totalAttempts: number;
    correctAttempts: number;
    incorrectAttempts: number;
    solveCount: number;
    solveRatePercent: number;
    firstBlood: { username: string; solvedAt: string } | null;
  }>;
  submissionTimeline: Array<{ bucket: string; total: number; valid: number; failed: number }>;
}

export function AdminAnalyticsPage() {
  const { user } = useAuth();
  const canExport = Boolean(user?.permissions.includes('analytics:export'));

  const [platform, setPlatform] = useState<PlatformAnalytics | null>(null);
  const [competitions, setCompetitions] = useState<AdminCompOption[]>([]);
  const [selectedCompId, setSelectedCompId] = useState('');
  const [compAnalytics, setCompAnalytics] = useState<CompetitionAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInitial = useCallback(async () => {
    if (!canExport) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [platRes, compRes] = await Promise.all([
        apiFetch<PlatformAnalytics>('/api/v1/admin/analytics/platform'),
        apiFetch<{ competitions: AdminCompOption[] }>('/api/v1/admin/competitions'),
      ]);
      setPlatform(platRes);
      setCompetitions(compRes.competitions);
      if (compRes.competitions[0] && !selectedCompId) {
        setSelectedCompId(compRes.competitions[0].id);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load analytics');
    } finally {
      setLoading(false);
    }
  }, [canExport, selectedCompId]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (!canExport || !selectedCompId) return;
    apiFetch<CompetitionAnalytics>(`/api/v1/admin/analytics/competitions/${selectedCompId}`)
      .then((res) => setCompAnalytics(res))
      .catch((err) =>
        setError(err instanceof ApiClientError ? err.message : 'Unable to load competition analytics'),
      );
  }, [canExport, selectedCompId]);

  if (!canExport) {
    return (
      <section className="dl-section" style={{ borderBottom: 'none' }}>
        <div className="dl-container">
          <StatusBanner kind="error" message="Authorization required: analytics:export permission missing." />
        </div>
      </section>
    );
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div className="dl-label">TELEMETRY &amp; REPORTING</div>
        <h1 className="dl-section-title" style={{ marginBottom: '24px' }}>
          ANALYTICS &amp; CSV EXPORTS
        </h1>

        {error && <StatusBanner kind="error" message={error} />}

        {loading && !platform ? (
          <div className="dl-label">COMPUTING PLATFORM ANALYTICS...</div>
        ) : (
          platform && (
            <>
              <div className="dl-grid dl-grid-4" style={{ marginBottom: '32px' }}>
                <Card>
                  <div className="dl-label">TOTAL SUBMISSIONS</div>
                  <div className="dl-display-2" style={{ color: 'var(--color-gold)' }}>
                    {platform.totals.submissions}
                  </div>
                  <div className="dl-label">
                    SOLVE RATE: {platform.totals.overallSolveRatePercent}%
                  </div>
                </Card>
                <Card>
                  <div className="dl-label">VALID / FAILED</div>
                  <div className="dl-display-2">{platform.totals.validSubmissions}</div>
                  <div className="dl-label">FAILED: {platform.totals.failedSubmissions}</div>
                </Card>
                <Card>
                  <div className="dl-label">MOST SOLVED</div>
                  <div className="dl-feature-title" style={{ fontSize: '18px', marginTop: '8px' }}>
                    {platform.mostSolvedChallenge?.title ?? 'NO DATA'}
                  </div>
                  <div className="dl-label">
                    {platform.mostSolvedChallenge ? `${platform.mostSolvedChallenge.solveCount} SOLVES` : '—'}
                  </div>
                </Card>
                <Card>
                  <div className="dl-label">HARDEST CHALLENGE</div>
                  <div className="dl-feature-title" style={{ fontSize: '18px', marginTop: '8px' }}>
                    {platform.hardestChallenge?.title ?? 'NO DATA'}
                  </div>
                  <div className="dl-label">
                    {platform.hardestChallenge
                      ? `${platform.hardestChallenge.solveCount} / ${platform.hardestChallenge.attemptCount} ATTEMPTS`
                      : '—'}
                  </div>
                </Card>
              </div>

              <div className="dl-grid dl-grid-2" style={{ marginBottom: '40px' }}>
                <Card>
                  <div className="dl-label" style={{ marginBottom: '12px' }}>
                    CATEGORY PERFORMANCE
                  </div>
                  {platform.categoryPerformance.map((c) => (
                    <div
                      key={c.slug}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        padding: '8px 0',
                        borderBottom: '1px solid var(--border-hairline)',
                      }}
                    >
                      <span>{c.name}</span>
                      <span className="dl-label">
                        {c.challengeCount} CHAL · {c.totalSolves} SOLVES
                      </span>
                    </div>
                  ))}
                </Card>

                <Card>
                  <div className="dl-label" style={{ marginBottom: '12px' }}>
                    DIFFICULTY PERFORMANCE
                  </div>
                  {platform.difficultyPerformance.length === 0 ? (
                    <div className="dl-label">NO CHALLENGES RECORDED</div>
                  ) : (
                    platform.difficultyPerformance.map((d) => (
                      <div
                        key={d.difficulty}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: '8px 0',
                          borderBottom: '1px solid var(--border-hairline)',
                        }}
                      >
                        <span>{d.difficulty}</span>
                        <span className="dl-label">
                          {d.challengeCount} CHAL · {d.totalSolves} SOLVES
                        </span>
                      </div>
                    ))
                  )}
                </Card>
              </div>
            </>
          )
        )}

        {/* Competition Analytics & CSV Export Toolbar */}
        <h2 className="dl-feature-title" style={{ marginBottom: '16px' }}>
          COMPETITION BREAKDOWN &amp; EXPORTS
        </h2>

        {competitions.length === 0 ? (
          <EmptyState
            title="NO COMPETITIONS AVAILABLE"
            description="Create a competition to inspect registration metrics, challenge solve rates, and export CSV reports."
          />
        ) : (
          <>
            <Card>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-end',
                  flexWrap: 'wrap',
                  gap: '16px',
                }}
              >
                <div className="dl-field" style={{ flex: '1 1 320px', marginBottom: 0 }}>
                  <label htmlFor="an-comp-select" className="dl-label">
                    SELECT COMPETITION
                  </label>
                  <select
                    id="an-comp-select"
                    className="dl-input"
                    value={selectedCompId}
                    onChange={(e) => setSelectedCompId(e.target.value)}
                  >
                    {competitions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title.toUpperCase()} ({c.status})
                      </option>
                    ))}
                  </select>
                </div>

                {selectedCompId && (
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <a
                      href={`/api/v1/admin/analytics/competitions/${selectedCompId}/export/standings.csv`}
                      className="dl-btn dl-btn-gold"
                    >
                      EXPORT STANDINGS CSV
                    </a>
                    <a
                      href={`/api/v1/admin/analytics/competitions/${selectedCompId}/export/challenges.csv`}
                      className="dl-btn dl-btn-ghost"
                    >
                      EXPORT CHALLENGES CSV
                    </a>
                    <a
                      href={`/api/v1/admin/analytics/competitions/${selectedCompId}/export/submissions.csv`}
                      className="dl-btn dl-btn-ghost"
                    >
                      EXPORT SUBMISSIONS CSV
                    </a>
                  </div>
                )}
              </div>
            </Card>

            {compAnalytics && (
              <div style={{ marginTop: '24px' }}>
                <div className="dl-grid dl-grid-4" style={{ marginBottom: '24px' }}>
                  <Card>
                    <div className="dl-label">REGISTERED PARTICIPANTS</div>
                    <div className="dl-display-2">{compAnalytics.summary.confirmedParticipants}</div>
                    <div className="dl-label">ACTIVE: {compAnalytics.summary.activeParticipants}</div>
                  </Card>
                  <Card>
                    <div className="dl-label">REGISTERED TEAMS</div>
                    <div className="dl-display-2">{compAnalytics.summary.confirmedTeams}</div>
                    <div className="dl-label">ACTIVE: {compAnalytics.summary.activeTeams}</div>
                  </Card>
                  <Card>
                    <div className="dl-label">SUBMISSIONS</div>
                    <div className="dl-display-2">{compAnalytics.summary.totalSubmissions}</div>
                  </Card>
                  <Card>
                    <div className="dl-label">VERIFIED SOLVES</div>
                    <div className="dl-display-2" style={{ color: 'var(--color-gold)' }}>
                      {compAnalytics.summary.totalSolves}
                    </div>
                  </Card>
                </div>

                <Card>
                  <div className="dl-label" style={{ marginBottom: '12px' }}>
                    CHALLENGE SOLVE DISTRIBUTION
                  </div>
                  {compAnalytics.challengeStats.length === 0 ? (
                    <div className="dl-label">NO CHALLENGES ASSIGNED TO THIS COMPETITION</div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--text-ash)' }}>
                            <th className="dl-label" style={{ padding: '10px 8px' }}>CHALLENGE</th>
                            <th className="dl-label" style={{ padding: '10px 8px' }}>DIFFICULTY</th>
                            <th className="dl-label" style={{ padding: '10px 8px' }}>ATTEMPTS</th>
                            <th className="dl-label" style={{ padding: '10px 8px' }}>SOLVES</th>
                            <th className="dl-label" style={{ padding: '10px 8px' }}>SOLVE RATE</th>
                            <th className="dl-label" style={{ padding: '10px 8px' }}>FIRST BLOOD</th>
                          </tr>
                        </thead>
                        <tbody>
                          {compAnalytics.challengeStats.map((cs) => (
                            <tr key={cs.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                              <td style={{ padding: '12px 8px' }}>{cs.title}</td>
                              <td style={{ padding: '12px 8px' }}>
                                <span className="dl-badge">{cs.difficulty}</span>
                              </td>
                              <td style={{ padding: '12px 8px' }}>
                                {cs.totalAttempts} ({cs.correctAttempts} OK / {cs.incorrectAttempts} FAIL)
                              </td>
                              <td style={{ padding: '12px 8px', color: 'var(--color-gold)' }}>
                                {cs.solveCount}
                              </td>
                              <td style={{ padding: '12px 8px' }}>{cs.solveRatePercent}%</td>
                              <td style={{ padding: '12px 8px', color: 'var(--text-ash)' }}>
                                {cs.firstBlood ? `@${cs.firstBlood.username}` : 'UNCLAIMED'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

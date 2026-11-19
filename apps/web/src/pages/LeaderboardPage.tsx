import { useCallback, useEffect, useState } from 'react';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBanner } from '../components/ui/StatusBanner';
import { ApiClientError, apiFetch } from '../lib/api';

interface RankedEntry {
  rank: number;
  entityId: string;
  entityType: 'INDIVIDUAL' | 'TEAM';
  name: string;
  slugOrUsername: string;
  country: string | null;
  totalPoints: number;
  solveCount: number;
  firstBloodCount: number;
  lastSolveAt: string | null;
}

interface RecentSolve {
  id: string;
  pointsAwarded: number;
  isFirstBlood: boolean;
  solvedAt: string;
  user: { username: string; displayName: string };
  team: { name: string; slug: string } | null;
  challenge: { slug: string; title: string };
}

interface CategoryStat {
  id: string;
  slug: string;
  name: string;
  publishedChallengeCount: number;
  totalSolves: number;
  firstBloodCount: number;
}

interface LeaderboardResponse {
  scope: 'GLOBAL' | 'COMPETITION';
  entityType: 'INDIVIDUAL' | 'TEAM';
  entries: RankedEntry[];
  currentUserEntry: RankedEntry | null;
  recentSolves: RecentSolve[];
  categoryStats: CategoryStat[];
  pagination: { page: number; totalPages: number; total: number };
}

interface CompOption {
  slug: string;
  title: string;
  status: string;
}

export function LeaderboardPage() {
  const [scopeSlug, setScopeSlug] = useState<string>('GLOBAL');
  const [entityType, setEntityType] = useState<'INDIVIDUAL' | 'TEAM'>('INDIVIDUAL');
  const [page, setPage] = useState(1);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [competitions, setCompetitions] = useState<CompOption[]>([]);
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ upcomingCompetitions: CompOption[] }>('/api/v1/public/overview')
      .then((res) => setCompetitions(res.upcomingCompetitions))
      .catch(() => {});
  }, []);

  const fetchBoard = useCallback(async () => {
    setError(null);
    try {
      const endpoint =
        scopeSlug === 'GLOBAL'
          ? `/api/v1/leaderboards/global?type=${entityType}&page=${page}&limit=25`
          : `/api/v1/leaderboards/competitions/${encodeURIComponent(scopeSlug)}?type=${entityType}&page=${page}&limit=25`;

      const res = await apiFetch<LeaderboardResponse>(endpoint);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load leaderboard');
    } finally {
      setLoading(false);
    }
  }, [entityType, page, scopeSlug]);

  useEffect(() => {
    setLoading(true);
    void fetchBoard();
  }, [fetchBoard]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      void fetchBoard();
    }, 30_000);
    return () => clearInterval(timer);
  }, [autoRefresh, fetchBoard]);

  const topThree = data && page === 1 ? data.entries.slice(0, 3) : [];

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
            <div className="dl-label">SERVER-COMPUTED STANDINGS</div>
            <h1 className="dl-section-title">LIVE LEADERBOARD</h1>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <Button
              type="button"
              variant={entityType === 'INDIVIDUAL' ? 'gold' : 'ghost'}
              onClick={() => {
                setPage(1);
                setEntityType('INDIVIDUAL');
              }}
            >
              INDIVIDUAL
            </Button>
            <Button
              type="button"
              variant={entityType === 'TEAM' ? 'gold' : 'ghost'}
              onClick={() => {
                setPage(1);
                setEntityType('TEAM');
              }}
            >
              TEAMS
            </Button>
            <Button type="button" variant="ghost" onClick={() => void fetchBoard()}>
              REFRESH
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setAutoRefresh((v) => !v)}
            >
              AUTO: {autoRefresh ? 'ON (30S)' : 'OFF'}
            </Button>
          </div>
        </div>

        {competitions.length > 0 && (
          <div className="dl-field" style={{ maxWidth: '380px', marginBottom: '24px' }}>
            <label htmlFor="lb-scope" className="dl-label">
              COMPETITION SCOPE
            </label>
            <select
              id="lb-scope"
              className="dl-input"
              value={scopeSlug}
              onChange={(e) => {
                setPage(1);
                setScopeSlug(e.target.value);
              }}
            >
              <option value="GLOBAL">GLOBAL RANKINGS</option>
              {competitions.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.title.toUpperCase()} ({c.status})
                </option>
              ))}
            </select>
          </div>
        )}

        {error && <StatusBanner kind="error" message={error} />}

        {/* Pinned Current User / Team Position */}
        {data?.currentUserEntry && (
          <div
            style={{
              border: '1px solid var(--color-gold)',
              background: 'var(--surface-charcoal)',
              padding: '16px 24px',
              marginBottom: '24px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '16px',
            }}
          >
            <div>
              <div className="dl-label" style={{ color: 'var(--color-gold)' }}>
                YOUR CURRENT POSITION
              </div>
              <div className="dl-feature-title" style={{ fontSize: '22px' }}>
                #{data.currentUserEntry.rank} · {data.currentUserEntry.name}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '24px' }}>
              <div>
                <div className="dl-label">SCORE</div>
                <div className="dl-caption" style={{ color: 'var(--color-gold)', fontSize: '18px' }}>
                  {data.currentUserEntry.totalPoints} PTS
                </div>
              </div>
              <div>
                <div className="dl-label">SOLVES</div>
                <div className="dl-caption" style={{ fontSize: '18px' }}>
                  {data.currentUserEntry.solveCount}
                </div>
              </div>
              <div>
                <div className="dl-label">FIRST BLOODS</div>
                <div className="dl-caption" style={{ fontSize: '18px' }}>
                  {data.currentUserEntry.firstBloodCount}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Top 3 Highlight Strip */}
        {topThree.length > 0 && (
          <div className="dl-grid dl-grid-3" style={{ marginBottom: '32px' }}>
            {topThree.map((entry) => (
              <div
                key={entry.entityId}
                style={{
                  background: 'var(--surface-charcoal)',
                  border:
                    entry.rank === 1
                      ? '1px solid var(--color-gold)'
                      : '1px solid var(--color-white)',
                  padding: '24px',
                }}
              >
                <span className={`dl-badge ${entry.rank === 1 ? 'dl-badge-gold' : ''}`}>
                  RANK #{entry.rank}
                </span>
                <h2 className="dl-feature-title" style={{ marginTop: '12px' }}>
                  {entry.name}
                </h2>
                <div className="dl-label">@{entry.slugOrUsername}</div>
                <div className="dl-display-2" style={{ color: 'var(--color-gold)', marginTop: '12px' }}>
                  {entry.totalPoints}
                </div>
                <div className="dl-label">
                  {entry.solveCount} SOLVES · {entry.firstBloodCount} FIRST BLOODS
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Standings Table */}
        {loading ? (
          <div className="dl-label">COMPUTING STANDINGS...</div>
        ) : !data || data.entries.length === 0 ? (
          <EmptyState
            title="NO RANKED SOLVES RECORDED"
            description="Verified solves and score transactions will populate the live leaderboard automatically."
          />
        ) : (
          <Card>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--text-ash)' }}>
                    <th className="dl-label" style={{ padding: '12px 8px' }}>RANK</th>
                    <th className="dl-label" style={{ padding: '12px 8px' }}>
                      {entityType === 'TEAM' ? 'TEAM' : 'OPERATOR'}
                    </th>
                    <th className="dl-label" style={{ padding: '12px 8px' }}>COUNTRY</th>
                    <th className="dl-label" style={{ padding: '12px 8px' }}>SCORE</th>
                    <th className="dl-label" style={{ padding: '12px 8px' }}>SOLVES</th>
                    <th className="dl-label" style={{ padding: '12px 8px' }}>1ST BLOOD</th>
                    <th className="dl-label" style={{ padding: '12px 8px' }}>LAST SOLVE</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((entry) => {
                    const isCurrent = data.currentUserEntry?.entityId === entry.entityId;
                    return (
                      <tr
                        key={entry.entityId}
                        style={{
                          borderBottom: '1px solid var(--border-hairline)',
                          borderLeft: isCurrent ? '3px solid var(--color-gold)' : '3px solid transparent',
                          backgroundColor: isCurrent ? 'var(--surface-iron)' : 'transparent',
                        }}
                      >
                        <td style={{ padding: '14px 8px', color: entry.rank <= 3 ? 'var(--color-gold)' : 'var(--color-white)' }}>
                          #{entry.rank}
                        </td>
                        <td style={{ padding: '14px 8px' }}>
                          <div>{entry.name}</div>
                          <div className="dl-label">@{entry.slugOrUsername}</div>
                        </td>
                        <td style={{ padding: '14px 8px', color: 'var(--text-ash)' }}>
                          {entry.country ?? '—'}
                        </td>
                        <td style={{ padding: '14px 8px', color: 'var(--color-gold)' }}>
                          {entry.totalPoints}
                        </td>
                        <td style={{ padding: '14px 8px' }}>{entry.solveCount}</td>
                        <td style={{ padding: '14px 8px' }}>{entry.firstBloodCount}</td>
                        <td style={{ padding: '14px 8px', color: 'var(--text-ash)', fontSize: '13px' }}>
                          {entry.lastSolveAt ? new Date(entry.lastSolveAt).toLocaleString() : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {data.pagination.totalPages > 1 && (
              <div style={{ display: 'flex', gap: '12px', marginTop: '20px', alignItems: 'center' }}>
                <Button type="button" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  PREVIOUS
                </Button>
                <span className="dl-label">
                  PAGE {data.pagination.page} / {data.pagination.totalPages}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={page >= data.pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  NEXT
                </Button>
              </div>
            )}
          </Card>
        )}

        {/* Category Statistics & Recent Solves Feed */}
        {data && (
          <div className="dl-grid dl-grid-2" style={{ marginTop: '40px' }}>
            <Card>
              <div className="dl-label" style={{ marginBottom: '12px' }}>
                CATEGORY BREAKDOWN
              </div>
              {data.categoryStats.map((cat) => (
                <div
                  key={cat.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '10px 0',
                    borderBottom: '1px solid var(--border-hairline)',
                  }}
                >
                  <span>{cat.name}</span>
                  <span className="dl-label">
                    {cat.publishedChallengeCount} CHAL · {cat.totalSolves} SOLVES
                  </span>
                </div>
              ))}
            </Card>

            <Card>
              <div className="dl-label" style={{ marginBottom: '12px' }}>
                RECENT SOLVES FEED
              </div>
              {data.recentSolves.length === 0 ? (
                <div className="dl-label">NO RECENT SOLVES</div>
              ) : (
                data.recentSolves.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '10px 0',
                      borderBottom: '1px solid var(--border-hairline)',
                    }}
                  >
                    <div>
                      <div>
                        <strong>{s.team ? s.team.name : `@${s.user.username}`}</strong> solved{' '}
                        {s.challenge.title}
                      </div>
                      <div className="dl-label">{new Date(s.solvedAt).toLocaleString()}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      {s.isFirstBlood && <span className="dl-badge dl-badge-gold">1ST BLOOD</span>}
                      <div style={{ color: 'var(--color-gold)', fontSize: '13px', marginTop: '4px' }}>
                        +{s.pointsAwarded} PTS
                      </div>
                    </div>
                  </div>
                ))
              )}
            </Card>
          </div>
        )}
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { HexMark } from '../components/ui/HexMark';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

interface AchievementCatalogRow {
  id: string;
  code: string;
  name: string;
  description: string;
  tier: string;
  iconKey: string;
  threshold: number;
  currentProgress?: number;
  progressPercent?: number;
  earned?: boolean;
  firstAwardedAt?: string | null;
}

interface AwardHistoryRow {
  id: string;
  code: string;
  name: string;
  description: string;
  tier: string;
  competition: { slug: string; title: string } | null;
  awardedAt: string;
}

export function AchievementsPage() {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState<AchievementCatalogRow[]>([]);
  const [history, setHistory] = useState<AwardHistoryRow[]>([]);
  const [showPublic, setShowPublic] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (user) {
        const res = await apiFetch<{
          showAchievementsOnProfile: boolean;
          catalog: AchievementCatalogRow[];
          history: AwardHistoryRow[];
        }>('/api/v1/achievements/me');
        setShowPublic(res.showAchievementsOnProfile);
        setCatalog(res.catalog);
        setHistory(res.history);
      } else {
        const res = await apiFetch<{ achievements: AchievementCatalogRow[] }>('/api/v1/achievements');
        setCatalog(res.achievements);
        setHistory([]);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load achievements');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  async function togglePrivacy() {
    setBusy(true);
    try {
      const next = !showPublic;
      await apiFetch('/api/v1/users/me/privacy', {
        method: 'PATCH',
        body: JSON.stringify({ showAchievementsOnProfile: next }),
      });
      setShowPublic(next);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to update privacy setting');
    } finally {
      setBusy(false);
    }
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
            <div className="dl-label">MERIT &amp; MILESTONES</div>
            <h1 className="dl-section-title">ACHIEVEMENTS</h1>
          </div>

          {user && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void togglePrivacy()}>
              PUBLIC PROFILE: {showPublic ? 'VISIBLE' : 'HIDDEN'}
            </Button>
          )}
        </div>

        {error && <StatusBanner kind="error" message={error} />}

        {!user && (
          <StatusBanner
            kind="info"
            message="Sign in to track your live achievement progress and earned award history."
          />
        )}

        {loading ? (
          <div className="dl-label">LOADING ACHIEVEMENTS...</div>
        ) : catalog.length === 0 ? (
          <EmptyState
            title="NO ACHIEVEMENTS CONFIGURED"
            description="Platform achievements seeded or published by administrators appear here."
          />
        ) : (
          <div className="dl-grid dl-grid-3">
            {catalog.map((ach) => {
              const earned = Boolean(ach.earned);
              const pct = ach.progressPercent ?? 0;
              return (
                <div
                  key={ach.id}
                  style={{
                    backgroundColor: 'var(--surface-charcoal)',
                    border: earned ? '1px solid var(--color-gold)' : '1px solid var(--border-hairline)',
                    padding: '24px',
                    opacity: !user || earned ? 1 : 0.72,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <HexMark size={26} stroke={earned ? '#FFC000' : '#7D7D7D'} />
                    <span className={`dl-badge ${earned ? 'dl-badge-gold' : ''}`}>
                      {ach.tier} · {user ? (earned ? 'UNLOCKED' : 'LOCKED') : 'AVAILABLE'}
                    </span>
                  </div>

                  <h2 className="dl-feature-title" style={{ fontSize: '20px', marginBottom: '8px' }}>
                    {ach.name}
                  </h2>
                  <p style={{ color: 'var(--text-ash)', fontSize: '14px', margin: '0 0 16px 0' }}>
                    {ach.description}
                  </p>

                  {user && (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <span className="dl-label">PROGRESS</span>
                        <span className="dl-label" style={{ color: earned ? 'var(--color-gold)' : 'var(--color-white)' }}>
                          {ach.currentProgress ?? 0} / {ach.threshold}
                        </span>
                      </div>
                      <div style={{ height: '6px', background: 'var(--color-black)', width: '100%' }}>
                        <div
                          style={{
                            height: '100%',
                            width: `${pct}%`,
                            background: earned ? 'var(--color-gold)' : 'var(--color-white)',
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {user && history.length > 0 && (
          <div style={{ marginTop: '48px' }}>
            <h2 className="dl-feature-title" style={{ marginBottom: '16px' }}>
              AWARD SNAPSHOT HISTORY
            </h2>
            <Card>
              {history.map((h) => (
                <div
                  key={h.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '12px',
                    padding: '12px 0',
                    borderBottom: '1px solid var(--border-hairline)',
                  }}
                >
                  <div>
                    <strong>{h.name}</strong>{' '}
                    <span className="dl-badge">{h.tier}</span>
                    <div className="dl-label">
                      {h.description}
                      {h.competition ? ` · ${h.competition.title}` : ''}
                    </div>
                  </div>
                  <div className="dl-label">{new Date(h.awardedAt).toLocaleString()}</div>
                </div>
              ))}
            </Card>
          </div>
        )}

        {user && (
          <div style={{ marginTop: '24px' }}>
            <LinkButton to={`/users/${user.username}`} variant="ghost">
              VIEW PUBLIC PROFILE SUMMARY
            </LinkButton>
          </div>
        )}
      </div>
    </section>
  );
}

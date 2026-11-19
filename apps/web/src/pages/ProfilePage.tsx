import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBanner } from '../components/ui/StatusBanner';
import { ApiClientError, apiFetch } from '../lib/api';

interface ProfileSummaryResponse {
  profile: {
    username: string;
    displayName: string;
    country: string | null;
    bio: string | null;
    joinedAt: string;
    totalPoints: number;
    solveCount: number;
  };
  achievementsHidden: boolean;
  achievements: Array<{
    id: string;
    code: string;
    name: string;
    description: string;
    tier: string;
    awardedAt: string;
  }>;
}

export function ProfilePage() {
  const { username } = useParams();
  const [data, setData] = useState<ProfileSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!username) return;
    setLoading(true);
    apiFetch<ProfileSummaryResponse>(`/api/v1/users/${encodeURIComponent(username)}/achievements`)
      .then((res) => setData(res))
      .catch((err) => setError(err instanceof ApiClientError ? err.message : 'Profile not found'))
      .finally(() => setLoading(false));
  }, [username]);

  if (loading) {
    return (
      <div className="dl-container dl-section">
        <div className="dl-label">LOADING OPERATOR PROFILE...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="dl-container dl-section" style={{ borderBottom: 'none' }}>
        <StatusBanner kind="error" message={error ?? 'Profile unavailable'} />
      </div>
    );
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div className="dl-label">OPERATOR PROFILE</div>
        <h1 className="dl-section-title" style={{ marginBottom: '8px' }}>
          {data.profile.displayName}
        </h1>
        <div className="dl-label" style={{ marginBottom: '24px' }}>
          @{data.profile.username}
          {data.profile.country ? ` · ${data.profile.country}` : ''} · JOINED{' '}
          {new Date(data.profile.joinedAt).toLocaleDateString()}
        </div>

        <div className="dl-grid dl-grid-3" style={{ marginBottom: '32px' }}>
          <Card>
            <div className="dl-label">TOTAL POINTS</div>
            <div className="dl-display-2" style={{ color: 'var(--color-gold)' }}>
              {data.profile.totalPoints}
            </div>
          </Card>
          <Card>
            <div className="dl-label">SOLVED CHALLENGES</div>
            <div className="dl-display-2">{data.profile.solveCount}</div>
          </Card>
          <Card>
            <div className="dl-label">ACHIEVEMENTS</div>
            <div className="dl-display-2">
              {data.achievementsHidden ? 'HIDDEN' : data.achievements.length}
            </div>
          </Card>
        </div>

        <h2 className="dl-feature-title" style={{ marginBottom: '16px' }}>
          EARNED ACHIEVEMENTS
        </h2>
        {data.achievementsHidden ? (
          <EmptyState
            title="ACHIEVEMENTS ARE PRIVATE"
            description="This operator has configured their achievement summary to remain private."
          />
        ) : data.achievements.length === 0 ? (
          <EmptyState
            title="NO ACHIEVEMENTS UNLOCKED YET"
            description="Achievements earned from valid solves and competition placements appear here."
          />
        ) : (
          <div className="dl-grid dl-grid-3">
            {data.achievements.map((a) => (
              <Card key={a.id}>
                <span className="dl-badge dl-badge-gold">{a.tier}</span>
                <h3 className="dl-feature-title" style={{ fontSize: '20px', marginTop: '12px' }}>
                  {a.name}
                </h3>
                <p style={{ color: 'var(--text-ash)', fontSize: '14px' }}>{a.description}</p>
                <div className="dl-label">{new Date(a.awardedAt).toLocaleDateString()}</div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

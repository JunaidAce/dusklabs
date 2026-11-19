import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

interface TeamListItem {
  id: string;
  name: string;
  slug: string;
  bio: string | null;
  memberCount: number;
  solveCount: number;
  captain: { username: string; displayName: string };
}

interface MyTeamsResponse {
  teams: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
    inviteCode?: string;
    memberCount: number;
    solveCount: number;
  }>;
  receivedInvitations: Array<{
    id: string;
    team: { id: string; name: string; slug: string };
    invitedBy: { username: string; displayName: string };
    message: string | null;
    expiresAt: string;
  }>;
}

export function TeamsPage() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [myData, setMyData] = useState<MyTeamsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamBio, setNewTeamBio] = useState('');
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [busy, setBusy] = useState(false);

  const loadData = useCallback(
    async (query = search) => {
      setLoading(true);
      setError(null);
      try {
        const qs = query.trim() ? `?search=${encodeURIComponent(query.trim())}` : '';
        const list = await apiFetch<{ teams: TeamListItem[] }>(`/api/v1/teams${qs}`);
        setTeams(list.teams);
        if (user) {
          const mine = await apiFetch<MyTeamsResponse>('/api/v1/teams/my');
          setMyData(mine);
        } else {
          setMyData(null);
        }
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : 'Unable to load teams');
      } finally {
        setLoading(false);
      }
    },
    [search, user],
  );

  useEffect(() => {
    void loadData('');
  }, [user]);

  async function handleCreateTeam(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await apiFetch('/api/v1/teams', {
        method: 'POST',
        body: JSON.stringify({ name: newTeamName, bio: newTeamBio || undefined }),
      });
      setNewTeamName('');
      setNewTeamBio('');
      setNotice('Team created. You have been assigned as Team Captain.');
      await loadData();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to create team');
    } finally {
      setBusy(false);
    }
  }

  async function handleJoinByCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await apiFetch<{ team: { name: string } }>('/api/v1/teams/join-by-code', {
        method: 'POST',
        body: JSON.stringify({ inviteCode: inviteCodeInput }),
      });
      setInviteCodeInput('');
      setNotice(`Joined team ${res.team.name}.`);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to join with invite code');
    } finally {
      setBusy(false);
    }
  }

  async function handleRespondInvite(invitationId: string, action: 'ACCEPT' | 'DECLINE') {
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/api/v1/teams/invitations/${invitationId}/respond`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      setNotice(action === 'ACCEPT' ? 'Invitation accepted.' : 'Invitation declined.');
      await loadData();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to respond to invitation');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div className="dl-label">SQUAD OPERATIONS</div>
        <h1 className="dl-section-title" style={{ marginBottom: '24px' }}>
          TEAMS &amp; ROSTERS
        </h1>

        {error && <StatusBanner kind="error" message={error} />}
        {notice && <StatusBanner kind="success" message={notice} />}

        {user && (
          <div className="dl-grid dl-grid-2" style={{ marginBottom: '48px' }}>
            <Card>
              <div className="dl-label" style={{ marginBottom: '12px' }}>
                CREATE A NEW TEAM
              </div>
              <form onSubmit={handleCreateTeam}>
                <Input
                  label="TEAM NAME"
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  required
                />
                <Input
                  label="TEAM BIO (OPTIONAL)"
                  value={newTeamBio}
                  onChange={(e) => setNewTeamBio(e.target.value)}
                />
                <Button type="submit" disabled={busy} style={{ width: '100%' }}>
                  CREATE TEAM
                </Button>
              </form>
            </Card>

            <Card>
              <div className="dl-label" style={{ marginBottom: '12px' }}>
                JOIN VIA INVITE CODE
              </div>
              <form onSubmit={handleJoinByCode}>
                <Input
                  label="INVITE CODE"
                  value={inviteCodeInput}
                  onChange={(e) => setInviteCodeInput(e.target.value)}
                  required
                />
                <Button type="submit" variant="ghost" disabled={busy} style={{ width: '100%' }}>
                  JOIN TEAM
                </Button>
              </form>

              {myData && myData.receivedInvitations.length > 0 && (
                <div style={{ marginTop: '24px', borderTop: '1px solid var(--border-hairline)', paddingTop: '16px' }}>
                  <div className="dl-label" style={{ marginBottom: '12px' }}>
                    PENDING INVITATIONS
                  </div>
                  {myData.receivedInvitations.map((inv) => (
                    <div key={inv.id} style={{ marginBottom: '12px' }}>
                      <div style={{ marginBottom: '8px' }}>
                        <strong>{inv.team.name}</strong> — invited by @{inv.invitedBy.username}
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <Button
                          type="button"
                          onClick={() => void handleRespondInvite(inv.id, 'ACCEPT')}
                          disabled={busy}
                        >
                          ACCEPT
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => void handleRespondInvite(inv.id, 'DECLINE')}
                          disabled={busy}
                        >
                          DECLINE
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {myData && myData.teams.length > 0 && (
          <div style={{ marginBottom: '48px' }}>
            <h2 className="dl-feature-title" style={{ marginBottom: '16px' }}>
              YOUR TEAMS
            </h2>
            <div className="dl-grid dl-grid-3">
              {myData.teams.map((t) => (
                <Card key={t.id}>
                  <span className="dl-badge dl-badge-gold">{t.role}</span>
                  <h3 className="dl-feature-title" style={{ marginTop: '12px' }}>
                    {t.name}
                  </h3>
                  <div className="dl-label" style={{ margin: '8px 0 16px 0' }}>
                    {t.memberCount} MEMBERS · {t.solveCount} SOLVES
                  </div>
                  <LinkButton to={`/teams/${t.slug}`} variant="ghost">
                    MANAGE TEAM
                  </LinkButton>
                </Card>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap', marginBottom: '24px' }}>
          <h2 className="dl-feature-title">DIRECTORY</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loadData(search);
            }}
            style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}
          >
            <Input
              label="SEARCH TEAMS"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button type="submit" variant="ghost" style={{ marginBottom: '16px' }}>
              FILTER
            </Button>
          </form>
        </div>

        {loading ? (
          <div className="dl-label">LOADING TEAMS...</div>
        ) : teams.length === 0 ? (
          <EmptyState
            title="NO TEAMS FOUND"
            description="No active teams match your search criteria. Create the first team or participate individually."
          />
        ) : (
          <div className="dl-grid dl-grid-3">
            {teams.map((t) => (
              <Card key={t.id}>
                <h3 className="dl-feature-title">{t.name}</h3>
                <div className="dl-label" style={{ marginTop: '4px' }}>
                  CAPTAIN: @{t.captain.username}
                </div>
                <p style={{ color: 'var(--text-ash)', fontSize: '14px', minHeight: '42px' }}>
                  {t.bio ?? 'No team biography provided.'}
                </p>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="dl-label">
                    {t.memberCount} MEMBERS · {t.solveCount} SOLVES
                  </span>
                  <Link to={`/teams/${t.slug}`} style={{ color: 'var(--color-gold)', fontSize: '12px' }}>
                    INSPECT →
                  </Link>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

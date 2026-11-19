import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

interface TeamDetail {
  id: string;
  name: string;
  slug: string;
  bio: string | null;
  captainId: string;
  totalPoints: number;
  solveCount: number;
  isMember: boolean;
  isCaptain: boolean;
  inviteCode?: string;
  members: Array<{
    userId: string;
    username: string;
    displayName: string;
    country: string | null;
    role: string;
  }>;
  competitions: Array<{
    id: string;
    slug: string;
    title: string;
    status: string;
  }>;
  pendingInvitations?: Array<{
    id: string;
    type: string;
    message: string | null;
    invitedUser: { id: string; username: string; displayName: string } | null;
  }>;
}

export function TeamDetailPage() {
  const { slug } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [inviteUsername, setInviteUsername] = useState('');
  const [requestMessage, setRequestMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const loadTeam = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<TeamDetail>(`/api/v1/teams/${encodeURIComponent(slug)}`);
      setTeam(data);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load team');
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void loadTeam();
  }, [loadTeam]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!team) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/teams/${team.id}/invitations`, {
        method: 'POST',
        body: JSON.stringify({ username: inviteUsername }),
      });
      setInviteUsername('');
      setNotice('Invitation dispatched.');
      await loadTeam();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Invitation failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleRequestJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!team) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/teams/${team.id}/requests`, {
        method: 'POST',
        body: JSON.stringify({ message: requestMessage || undefined }),
      });
      setRequestMessage('');
      setNotice('Join request sent to the Team Captain.');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleRespondRequest(invitationId: string, action: 'ACCEPT' | 'DECLINE') {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/teams/invitations/${invitationId}/respond`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      await loadTeam();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleRegenerateCode() {
    if (!team) return;
    setBusy(true);
    try {
      await apiFetch(`/api/v1/teams/${team.id}/invite-code/regenerate`, { method: 'POST' });
      setNotice('Invite code regenerated.');
      await loadTeam();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to regenerate invite code');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveMember(targetUserId: string) {
    if (!team) return;
    setBusy(true);
    try {
      await apiFetch(`/api/v1/teams/${team.id}/members/${targetUserId}`, { method: 'DELETE' });
      await loadTeam();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to remove member');
    } finally {
      setBusy(false);
    }
  }

  async function handleTransferCaptain(newCaptainUserId: string) {
    if (!team) return;
    setBusy(true);
    try {
      await apiFetch(`/api/v1/teams/${team.id}/transfer-captain`, {
        method: 'POST',
        body: JSON.stringify({ newCaptainUserId }),
      });
      setNotice('Captaincy transferred.');
      await loadTeam();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to transfer captaincy');
    } finally {
      setBusy(false);
    }
  }

  async function handleLeave() {
    if (!team) return;
    setBusy(true);
    try {
      await apiFetch(`/api/v1/teams/${team.id}/leave`, { method: 'POST' });
      navigate('/teams');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to leave team');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="dl-container dl-section">
        <div className="dl-label">LOADING TEAM DOSSIER...</div>
      </div>
    );
  }

  if (!team) {
    return (
      <div className="dl-container dl-section">
        {error && <StatusBanner kind="error" message={error} />}
      </div>
    );
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div className="dl-label">TEAM DOSSIER</div>
        <h1 className="dl-section-title" style={{ marginBottom: '12px' }}>
          {team.name}
        </h1>
        <p style={{ color: 'var(--text-ash)', marginBottom: '32px' }}>
          {team.bio ?? 'No team biography provided.'}
        </p>

        {error && <StatusBanner kind="error" message={error} />}
        {notice && <StatusBanner kind="success" message={notice} />}

        <div className="dl-grid dl-grid-3" style={{ marginBottom: '40px' }}>
          <Card>
            <div className="dl-label">TEAM POINTS</div>
            <div className="dl-display-2" style={{ color: 'var(--color-gold)' }}>
              {team.totalPoints}
            </div>
          </Card>
          <Card>
            <div className="dl-label">CHALLENGES SOLVED</div>
            <div className="dl-display-2">{team.solveCount}</div>
          </Card>
          <Card>
            <div className="dl-label">ACTIVE ROSTER</div>
            <div className="dl-display-2">{team.members.length}</div>
          </Card>
        </div>

        <div className="dl-grid dl-grid-2">
          <Card>
            <h2 className="dl-feature-title" style={{ marginBottom: '16px' }}>
              ROSTER
            </h2>
            {team.members.map((m) => (
              <div
                key={m.userId}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '12px 0',
                  borderBottom: '1px solid var(--border-hairline)',
                }}
              >
                <div>
                  <div>
                    {m.displayName} <span style={{ color: 'var(--text-ash)' }}>@{m.username}</span>
                  </div>
                  <span className={`dl-badge ${m.role === 'CAPTAIN' ? 'dl-badge-gold' : ''}`}>
                    {m.role}
                  </span>
                </div>
                {team.isCaptain && m.userId !== team.captainId && (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void handleTransferCaptain(m.userId)}
                    >
                      MAKE CAPTAIN
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void handleRemoveMember(m.userId)}
                    >
                      REMOVE
                    </Button>
                  </div>
                )}
              </div>
            ))}

            {team.isMember && (
              <div style={{ marginTop: '20px' }}>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => void handleLeave()}>
                  LEAVE TEAM
                </Button>
              </div>
            )}
          </Card>

          <div>
            {team.isCaptain && (
              <Card>
                <h2 className="dl-feature-title" style={{ marginBottom: '16px' }}>
                  CAPTAIN CONTROLS
                </h2>
                <div className="dl-label">INVITE CODE</div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    background: 'var(--color-black)',
                    padding: '12px',
                    border: '1px solid var(--text-ash)',
                    marginBottom: '20px',
                  }}
                >
                  <code>{team.inviteCode}</code>
                  <Button type="button" variant="ghost" disabled={busy} onClick={() => void handleRegenerateCode()}>
                    ROTATE
                  </Button>
                </div>

                <form onSubmit={handleInvite}>
                  <Input
                    label="INVITE PARTICIPANT BY USERNAME"
                    value={inviteUsername}
                    onChange={(e) => setInviteUsername(e.target.value)}
                    required
                  />
                  <Button type="submit" disabled={busy} style={{ width: '100%' }}>
                    SEND INVITATION
                  </Button>
                </form>

                {team.pendingInvitations &&
                  team.pendingInvitations.filter((p) => p.type === 'REQUEST').length > 0 && (
                    <div style={{ marginTop: '24px', borderTop: '1px solid var(--border-hairline)', paddingTop: '16px' }}>
                      <div className="dl-label" style={{ marginBottom: '12px' }}>
                        JOIN REQUESTS
                      </div>
                      {team.pendingInvitations
                        .filter((p) => p.type === 'REQUEST')
                        .map((req) => (
                          <div key={req.id} style={{ marginBottom: '12px' }}>
                            <div style={{ marginBottom: '6px' }}>
                              @{req.invitedUser?.username} {req.message ? `— "${req.message}"` : ''}
                            </div>
                            <div style={{ display: 'flex', gap: '8px' }}>
                              <Button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleRespondRequest(req.id, 'ACCEPT')}
                              >
                                APPROVE
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void handleRespondRequest(req.id, 'DECLINE')}
                              >
                                DECLINE
                              </Button>
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
              </Card>
            )}

            {user && !team.isMember && (
              <Card>
                <h2 className="dl-feature-title" style={{ marginBottom: '16px' }}>
                  REQUEST MEMBERSHIP
                </h2>
                <form onSubmit={handleRequestJoin}>
                  <Input
                    label="MESSAGE TO CAPTAIN (OPTIONAL)"
                    value={requestMessage}
                    onChange={(e) => setRequestMessage(e.target.value)}
                  />
                  <Button type="submit" disabled={busy} style={{ width: '100%' }}>
                    SEND JOIN REQUEST
                  </Button>
                </form>
              </Card>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

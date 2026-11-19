import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { SafeMarkdown } from '../components/ui/SafeMarkdown';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

export type CompetitionTab = 'overview' | 'rules' | 'challenges' | 'leaderboard' | 'announcements';

interface CompetitionDetail {
  id: string;
  slug: string;
  title: string;
  description: string;
  bannerUrl: string | null;
  rules: string;
  status: string;
  timezone: string;
  participationMode: string;
  minTeamSize: number;
  maxTeamSize: number;
  lockTeamRosterOnLive: boolean;
  scoringMode: string;
  dynamicScoringPolicy: string;
  allowNegativeScores: boolean;
  firstBloodEnabled: boolean;
  registrationOpenAt: string | null;
  registrationCloseAt: string | null;
  startsAt: string;
  endsAt: string;
  organizers: Array<{ id: string; username: string; displayName: string }>;
  participantCount: number;
  teamCount: number;
  challengeCount: number;
  announcementCount: number;
  lifecycle: {
    registrationOpen: boolean;
    registrationReason: string;
    submissionsOpen: boolean;
    submissionReason: string;
  };
}

interface RegistrationStatus {
  status: 'NOT_REGISTERED' | 'CONFIRMED' | 'WITHDRAWN' | 'DISQUALIFIED';
  mode: 'INDIVIDUAL' | 'TEAM' | null;
  team: { id: string; name: string; slug: string; isCaptain: boolean } | null;
  registeredAt: string | null;
  cancelledAt: string | null;
  windowOpen: boolean;
  canRegisterIndividual: boolean;
  canRegisterTeam: boolean;
  eligibleTeams: Array<{
    id: string;
    name: string;
    slug: string;
    memberCount: number;
    meetsSizeLimits: boolean;
  }>;
  canCancel: boolean;
  cancelReason: string;
  history: Array<{
    id: string;
    action: string;
    reason: string | null;
    createdAt: string;
  }>;
}

interface CompChallengeItem {
  id: string;
  slug: string;
  title: string;
  difficulty: string;
  points: number;
  categories: Array<{ id: string; slug: string; name: string }>;
  tags: string[];
  solveCount: number;
  attachmentCount: number;
}

interface RankedEntry {
  rank: number;
  entityId: string;
  name: string;
  slugOrUsername: string;
  totalPoints: number;
  solveCount: number;
  firstBloodCount: number;
  lastSolveAt: string | null;
}

interface AnnouncementItem {
  id: string;
  title: string;
  body: string;
  isPinned: boolean;
  publishedAt: string;
  author: { username: string; displayName: string };
}

function formatTz(iso: string | null, tz: string): string {
  if (!iso) return 'NOT SPECIFIED';
  try {
    return `${new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: tz,
    }).format(new Date(iso))} (${tz})`;
  } catch {
    return new Date(iso).toUTCString();
  }
}

export function CompetitionDetailPage({ initialTab = 'overview' }: { initialTab?: CompetitionTab }) {
  const { slug } = useParams();
  const { user } = useAuth();

  const [tab, setTab] = useState<CompetitionTab>(initialTab);
  const [comp, setComp] = useState<CompetitionDetail | null>(null);
  const [regStatus, setRegStatus] = useState<RegistrationStatus | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState('');

  const [challenges, setChallenges] = useState<CompChallengeItem[]>([]);
  const [challengesError, setChallengesError] = useState<string | null>(null);
  const [challengesLoading, setChallengesLoading] = useState(false);

  const [lbType, setLbType] = useState<'INDIVIDUAL' | 'TEAM'>('INDIVIDUAL');
  const [lbEntries, setLbEntries] = useState<RankedEntry[]>([]);
  const [lbCurrent, setLbCurrent] = useState<RankedEntry | null>(null);
  const [lbLoading, setLbLoading] = useState(false);

  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [annLoading, setAnnLoading] = useState(false);
  const [annTitle, setAnnTitle] = useState('');
  const [annBody, setAnnBody] = useState('');
  const [annPinned, setAnnPinned] = useState(false);
  const [annBusy, setAnnBusy] = useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const loadCompetition = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ competition: CompetitionDetail }>(
        `/api/v1/competitions/${encodeURIComponent(slug)}`,
      );
      setComp(res.competition);
      setLbType(res.competition.participationMode === 'TEAM' ? 'TEAM' : 'INDIVIDUAL');

      if (user) {
        const rs = await apiFetch<RegistrationStatus>(
          `/api/v1/competitions/${res.competition.id}/register/status`,
        );
        setRegStatus(rs);
        const firstEligible = rs.eligibleTeams.find((t) => t.meetsSizeLimits) ?? rs.eligibleTeams[0];
        if (firstEligible && !selectedTeamId) {
          setSelectedTeamId(firstEligible.id);
        }
      } else {
        setRegStatus(null);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load competition');
    } finally {
      setLoading(false);
    }
  }, [slug, user, selectedTeamId]);

  useEffect(() => {
    void loadCompetition();
  }, [loadCompetition]);

  useEffect(() => {
    if (!comp || tab !== 'challenges') return;
    setChallengesLoading(true);
    setChallengesError(null);
    apiFetch<{ challenges: CompChallengeItem[] }>(
      `/api/v1/challenges?competitionSlug=${encodeURIComponent(comp.slug)}`,
    )
      .then((res) => setChallenges(res.challenges))
      .catch((err) => {
        setChallenges([]);
        setChallengesError(
          err instanceof ApiClientError ? err.message : 'Challenges are currently inaccessible.',
        );
      })
      .finally(() => setChallengesLoading(false));
  }, [comp, tab]);

  useEffect(() => {
    if (!comp || tab !== 'leaderboard') return;
    setLbLoading(true);
    apiFetch<{ entries: RankedEntry[]; currentUserEntry: RankedEntry | null }>(
      `/api/v1/leaderboards/competitions/${encodeURIComponent(comp.slug)}?type=${lbType}&limit=50`,
    )
      .then((res) => {
        setLbEntries(res.entries);
        setLbCurrent(res.currentUserEntry);
      })
      .catch(() => {})
      .finally(() => setLbLoading(false));
  }, [comp, tab, lbType]);

  const canPublishAnnouncement = Boolean(user?.permissions.includes('announcement:publish') && comp);

  const reloadAnnouncements = useCallback(async () => {
    if (!comp) return;
    setAnnLoading(true);
    try {
      const res = await apiFetch<{ announcements: AnnouncementItem[] }>(
        `/api/v1/competitions/${encodeURIComponent(comp.slug)}/announcements`,
      );
      setAnnouncements(res.announcements);
    } catch {
      // Non-blocking
    } finally {
      setAnnLoading(false);
    }
  }, [comp]);

  useEffect(() => {
    if (tab === 'announcements') {
      void reloadAnnouncements();
    }
  }, [tab, reloadAnnouncements]);

  async function handlePublishAnnouncement(e: FormEvent) {
    e.preventDefault();
    if (!comp) return;
    setError(null);
    setNotice(null);
    setAnnBusy(true);
    try {
      await apiFetch(`/api/v1/competitions/${comp.id}/announcements`, {
        method: 'POST',
        body: JSON.stringify({ title: annTitle, body: annBody, isPinned: annPinned }),
      });
      setAnnTitle('');
      setAnnBody('');
      setAnnPinned(false);
      setNotice('Announcement published.');
      await reloadAnnouncements();
      await loadCompetition();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to publish announcement');
    } finally {
      setAnnBusy(false);
    }
  }

  async function handleRegisterIndividual() {
    if (!comp) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/v1/competitions/${comp.id}/register/individual`, { method: 'POST' });
      setNotice('Individual registration confirmed.');
      await loadCompetition();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleRegisterTeam() {
    if (!comp || !selectedTeamId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/v1/competitions/${comp.id}/register/team`, {
        method: 'POST',
        body: JSON.stringify({ teamId: selectedTeamId }),
      });
      setNotice('Team registration confirmed for all eligible team members.');
      await loadCompetition();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Team registration failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelRegistration() {
    if (!comp) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/v1/competitions/${comp.id}/register/cancel`, { method: 'POST' });
      setNotice('Registration cancelled.');
      await loadCompetition();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to cancel registration');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="dl-container dl-section">
        <div className="dl-label">LOADING COMPETITION DOSSIER...</div>
      </div>
    );
  }

  if (!comp) {
    return (
      <div className="dl-container dl-section" style={{ borderBottom: 'none' }}>
        <StatusBanner kind="error" message={error ?? 'Competition not found'} />
        <LinkButton to="/competitions" variant="ghost">
          BACK TO COMPETITIONS
        </LinkButton>
      </div>
    );
  }

  const tabs: Array<{ key: CompetitionTab; label: string; path: string }> = [
    { key: 'overview', label: 'OVERVIEW & REGISTRATION', path: `/competitions/${comp.slug}` },
    { key: 'rules', label: 'RULES & SCORING', path: `/competitions/${comp.slug}/rules` },
    { key: 'challenges', label: `CHALLENGES (${comp.challengeCount})`, path: `/competitions/${comp.slug}/challenges` },
    { key: 'leaderboard', label: 'LEADERBOARD', path: `/competitions/${comp.slug}/leaderboard` },
    { key: 'announcements', label: `ANNOUNCEMENTS (${comp.announcementCount})`, path: `/competitions/${comp.slug}/announcements` },
  ];

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div style={{ marginBottom: '16px' }}>
          <Link to="/competitions" className="dl-label">
            ← ALL COMPETITIONS
          </Link>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
          <span className={`dl-badge ${comp.status === 'LIVE' || comp.status === 'REGISTRATION_OPEN' ? 'dl-badge-gold' : ''}`}>
            {comp.status}
          </span>
          <span className="dl-badge">{comp.participationMode}</span>
          <span className="dl-badge">{comp.scoringMode} SCORING</span>
          <span className="dl-badge">{comp.timezone}</span>
        </div>

        <h1 className="dl-section-title" style={{ marginBottom: '16px' }}>
          {comp.title}
        </h1>

        {error && <StatusBanner kind="error" message={error} />}
        {notice && <StatusBanner kind="success" message={notice} />}

        <StatusBanner
          kind={comp.lifecycle.submissionsOpen ? 'success' : 'info'}
          message={`${comp.lifecycle.registrationReason} ${comp.lifecycle.submissionReason}`}
        />

        {/* Sub-navigation Tabs */}
        <div
          role="tablist"
          aria-label="Competition Sections"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            borderBottom: '1px solid var(--border-hairline)',
            paddingBottom: '16px',
            marginBottom: '32px',
          }}
        >
          {tabs.map((t) => (
            <Link
              key={t.key}
              to={t.path}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`dl-btn ${tab === t.key ? 'dl-btn-gold' : 'dl-btn-ghost'}`}
            >
              {t.label}
            </Link>
          ))}
        </div>

        {/* TAB 1: OVERVIEW & REGISTRATION */}
        {tab === 'overview' && (
          <>
            <div className="dl-grid dl-grid-3" style={{ marginBottom: '32px' }}>
              <Card>
                <div className="dl-label">COMPETITION WINDOW</div>
                <div style={{ marginTop: '8px', fontSize: '14px' }}>
                  <div>START: {formatTz(comp.startsAt, comp.timezone)}</div>
                  <div style={{ marginTop: '4px' }}>END: {formatTz(comp.endsAt, comp.timezone)}</div>
                </div>
              </Card>
              <Card>
                <div className="dl-label">REGISTRATION WINDOW</div>
                <div style={{ marginTop: '8px', fontSize: '14px' }}>
                  <div>OPEN: {formatTz(comp.registrationOpenAt, comp.timezone)}</div>
                  <div style={{ marginTop: '4px' }}>CLOSE: {formatTz(comp.registrationCloseAt, comp.timezone)}</div>
                </div>
              </Card>
              <Card>
                <div className="dl-label">PARTICIPATION METRICS</div>
                <div style={{ marginTop: '8px', fontSize: '14px' }}>
                  <div>{comp.participantCount} PARTICIPANTS · {comp.teamCount} TEAMS</div>
                  <div style={{ marginTop: '4px' }}>
                    TEAM SIZE: {comp.minTeamSize}–{comp.maxTeamSize} · {comp.challengeCount} CHALLENGES
                  </div>
                </div>
              </Card>
            </div>

            <div className="dl-grid dl-grid-2" style={{ alignItems: 'start' }}>
              <Card>
                <div className="dl-label" style={{ marginBottom: '12px' }}>
                  BRIEFING
                </div>
                <SafeMarkdown content={comp.description} />
                {comp.organizers.length > 0 && (
                  <div className="dl-label" style={{ marginTop: '20px', borderTop: '1px solid var(--border-hairline)', paddingTop: '12px' }}>
                    ORGANIZERS: {comp.organizers.map((o) => `@${o.username}`).join(', ')}
                  </div>
                )}
              </Card>

              <Card>
                <div className="dl-label" style={{ marginBottom: '12px' }}>
                  REGISTRATION &amp; PARTICIPATION
                </div>

                {!user ? (
                  <div>
                    <p style={{ color: 'var(--text-ash)', marginTop: 0 }}>
                      Sign in with a DuskLabs operator account to view eligibility and register.
                    </p>
                    <LinkButton to="/login" variant="gold">
                      SIGN IN TO REGISTER
                    </LinkButton>
                  </div>
                ) : !regStatus ? (
                  <div className="dl-label">LOADING REGISTRATION STATUS...</div>
                ) : (
                  <div>
                    <div style={{ marginBottom: '16px' }}>
                      <span
                        className={`dl-badge ${regStatus.status === 'CONFIRMED' ? 'dl-badge-gold' : ''}`}
                      >
                        {regStatus.status === 'CONFIRMED'
                          ? regStatus.mode === 'TEAM'
                            ? `REGISTERED AS TEAM: ${regStatus.team?.name}`
                            : 'REGISTERED INDIVIDUALLY'
                          : regStatus.status}
                      </span>
                    </div>

                    {regStatus.canRegisterIndividual && (
                      <div style={{ marginBottom: '16px' }}>
                        <Button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleRegisterIndividual()}
                          style={{ width: '100%' }}
                        >
                          REGISTER INDIVIDUALLY
                        </Button>
                      </div>
                    )}

                    {regStatus.canRegisterTeam && (
                      <div style={{ marginBottom: '16px', paddingTop: '12px', borderTop: '1px solid var(--border-hairline)' }}>
                        {regStatus.eligibleTeams.length === 0 ? (
                          <div>
                            <p style={{ color: 'var(--text-ash)', fontSize: '14px', marginTop: 0 }}>
                              You must be a Team Captain to register a team (size {comp.minTeamSize}–{comp.maxTeamSize}).
                            </p>
                            <LinkButton to="/teams" variant="ghost">
                              CREATE OR MANAGE TEAM
                            </LinkButton>
                          </div>
                        ) : (
                          <>
                            <div className="dl-field">
                              <label htmlFor="reg-team-select" className="dl-label">
                                SELECT TEAM (CAPTAIN)
                              </label>
                              <select
                                id="reg-team-select"
                                className="dl-input"
                                value={selectedTeamId}
                                onChange={(e) => setSelectedTeamId(e.target.value)}
                              >
                                {regStatus.eligibleTeams.map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.name} ({t.memberCount} MEMBERS{t.meetsSizeLimits ? '' : ' — SIZE INELIGIBLE'})
                                  </option>
                                ))}
                              </select>
                            </div>
                            <Button
                              type="button"
                              disabled={busy || !selectedTeamId}
                              onClick={() => void handleRegisterTeam()}
                              style={{ width: '100%' }}
                            >
                              REGISTER SELECTED TEAM
                            </Button>
                          </>
                        )}
                      </div>
                    )}

                    {regStatus.status === 'CONFIRMED' && (
                      <div style={{ marginTop: '12px' }}>
                        {regStatus.canCancel ? (
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void handleCancelRegistration()}
                            style={{ width: '100%' }}
                          >
                            CANCEL REGISTRATION
                          </Button>
                        ) : (
                          <div className="dl-label">{regStatus.cancelReason}</div>
                        )}
                      </div>
                    )}

                    {regStatus.history.length > 0 && (
                      <div style={{ marginTop: '20px', borderTop: '1px solid var(--border-hairline)', paddingTop: '12px' }}>
                        <div className="dl-label" style={{ marginBottom: '8px' }}>
                          YOUR REGISTRATION HISTORY
                        </div>
                        {regStatus.history.map((h) => (
                          <div key={h.id} style={{ fontSize: '13px', padding: '6px 0', color: 'var(--text-ash)' }}>
                            <strong style={{ color: 'var(--color-white)' }}>{h.action}</strong>
                            {h.reason ? ` — ${h.reason}` : ''} · {new Date(h.createdAt).toLocaleString()}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            </div>
          </>
        )}

        {/* TAB 2: RULES & SCORING POLICY */}
        {tab === 'rules' && (
          <div className="dl-grid dl-grid-2" style={{ alignItems: 'start' }}>
            <Card>
              <div className="dl-label" style={{ marginBottom: '12px' }}>
                COMPETITION RULES
              </div>
              <SafeMarkdown content={comp.rules} />
            </Card>
            <Card>
              <div className="dl-label" style={{ marginBottom: '12px' }}>
                TECHNICAL &amp; SCORING POLICY
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '14px' }}>
                <div>PARTICIPATION MODE: <strong>{comp.participationMode}</strong></div>
                <div>TEAM SIZE LIMITS: <strong>{comp.minTeamSize} TO {comp.maxTeamSize} MEMBERS</strong></div>
                <div>ROSTER LOCK WHILE LIVE: <strong>{comp.lockTeamRosterOnLive ? 'ENABLED' : 'DISABLED'}</strong></div>
                <div>SCORING MODEL: <strong>{comp.scoringMode} ({comp.dynamicScoringPolicy})</strong></div>
                <div>FIRST BLOOD BONUS: <strong>{comp.firstBloodEnabled ? 'ENABLED' : 'DISABLED'}</strong></div>
                <div>NEGATIVE SCORES: <strong>{comp.allowNegativeScores ? 'PERMITTED' : 'CLAMPED AT 0'}</strong></div>
              </div>
            </Card>
          </div>
        )}

        {/* TAB 3: COMPETITION CHALLENGES */}
        {tab === 'challenges' && (
          <div>
            {challengesLoading ? (
              <div className="dl-label">LOADING COMPETITION CHALLENGES...</div>
            ) : challengesError ? (
              <EmptyState
                title="CHALLENGES CURRENTLY LOCKED"
                description={challengesError}
                action={
                  <Button type="button" variant="gold" onClick={() => setTab('overview')}>
                    CHECK REGISTRATION &amp; SCHEDULE
                  </Button>
                }
              />
            ) : challenges.length === 0 ? (
              <EmptyState
                title="NO PUBLISHED CHALLENGES IN THIS COMPETITION"
                description="Challenges assigned and published by the Competition Organizer will appear here."
              />
            ) : (
              <div className="dl-grid dl-grid-3">
                {challenges.map((c) => (
                  <Card key={c.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="dl-badge">{c.difficulty}</span>
                      <span className="dl-caption" style={{ color: 'var(--color-gold)' }}>
                        {c.points} PTS
                      </span>
                    </div>
                    <h2 className="dl-feature-title" style={{ marginTop: '12px' }}>
                      {c.title}
                    </h2>
                    <div className="dl-label" style={{ marginTop: '6px' }}>
                      {c.categories.map((cat) => cat.name).join(' · ')}
                    </div>
                    <div className="dl-label" style={{ margin: '10px 0 16px 0' }}>
                      {c.solveCount} SOLVES · {c.attachmentCount} ARTIFACTS
                    </div>
                    <LinkButton to={`/challenges/${c.slug}`} variant="ghost">
                      OPEN CHALLENGE →
                    </LinkButton>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 4: COMPETITION LEADERBOARD */}
        {tab === 'leaderboard' && (
          <div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
              <Button
                type="button"
                variant={lbType === 'INDIVIDUAL' ? 'gold' : 'ghost'}
                onClick={() => setLbType('INDIVIDUAL')}
              >
                INDIVIDUAL
              </Button>
              <Button
                type="button"
                variant={lbType === 'TEAM' ? 'gold' : 'ghost'}
                onClick={() => setLbType('TEAM')}
              >
                TEAMS
              </Button>
            </div>

            {lbCurrent && (
              <div
                style={{
                  border: '1px solid var(--color-gold)',
                  background: 'var(--surface-charcoal)',
                  padding: '16px',
                  marginBottom: '20px',
                }}
              >
                <span className="dl-label" style={{ color: 'var(--color-gold)' }}>
                  YOUR RANK: #{lbCurrent.rank} · {lbCurrent.name} · {lbCurrent.totalPoints} PTS ({lbCurrent.solveCount} SOLVES)
                </span>
              </div>
            )}

            {lbLoading ? (
              <div className="dl-label">COMPUTING COMPETITION STANDINGS...</div>
            ) : lbEntries.length === 0 ? (
              <EmptyState
                title="NO SCORES RECORDED YET"
                description="Rankings update automatically when registered participants solve challenges."
              />
            ) : (
              <Card>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--text-ash)' }}>
                        <th className="dl-label" style={{ padding: '10px 8px' }}>RANK</th>
                        <th className="dl-label" style={{ padding: '10px 8px' }}>PARTICIPANT</th>
                        <th className="dl-label" style={{ padding: '10px 8px' }}>SCORE</th>
                        <th className="dl-label" style={{ padding: '10px 8px' }}>SOLVES</th>
                        <th className="dl-label" style={{ padding: '10px 8px' }}>1ST BLOOD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lbEntries.map((entry) => (
                        <tr key={entry.entityId} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                          <td style={{ padding: '12px 8px', color: entry.rank <= 3 ? 'var(--color-gold)' : 'var(--color-white)' }}>
                            #{entry.rank}
                          </td>
                          <td style={{ padding: '12px 8px' }}>
                            {entry.name} <span className="dl-label">@{entry.slugOrUsername}</span>
                          </td>
                          <td style={{ padding: '12px 8px', color: 'var(--color-gold)' }}>
                            {entry.totalPoints}
                          </td>
                          <td style={{ padding: '12px 8px' }}>{entry.solveCount}</td>
                          <td style={{ padding: '12px 8px' }}>{entry.firstBloodCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        )}

        {/* TAB 5: ANNOUNCEMENTS */}
        {tab === 'announcements' && (
          <div>
            {canPublishAnnouncement && (
              <div style={{ marginBottom: '24px' }}>
                <Card>
                  <div className="dl-label" style={{ marginBottom: '12px' }}>
                    PUBLISH ANNOUNCEMENT
                  </div>
                  <form onSubmit={handlePublishAnnouncement} noValidate>
                    <Input
                      label="TITLE"
                      value={annTitle}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setAnnTitle(e.target.value)}
                      required
                    />
                    <div className="dl-field">
                      <label htmlFor="comp-ann-body" className="dl-label">
                        MESSAGE (MARKDOWN)
                      </label>
                      <textarea
                        id="comp-ann-body"
                        className="dl-input"
                        rows={5}
                        value={annBody}
                        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setAnnBody(e.target.value)}
                        required
                      />
                    </div>
                    <label className="dl-label" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                      <input
                        type="checkbox"
                        checked={annPinned}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => setAnnPinned(e.target.checked)}
                      />
                      PIN TO TOP
                    </label>
                    <Button type="submit" disabled={annBusy}>
                      {annBusy ? 'PUBLISHING...' : 'PUBLISH ANNOUNCEMENT'}
                    </Button>
                  </form>
                </Card>
              </div>
            )}

            {annLoading ? (
              <div className="dl-label">LOADING ANNOUNCEMENTS...</div>
            ) : announcements.length === 0 ? (
              <EmptyState
                title="NO ANNOUNCEMENTS PUBLISHED"
                description="Organizer updates, clarifications, and schedule notices for this event will appear here."
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {announcements.map((a) => (
                  <Card key={a.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <div>
                        {a.isPinned && <span className="dl-badge dl-badge-gold" style={{ marginRight: '8px' }}>PINNED</span>}
                        <span className="dl-label">
                          BY @{a.author.username} · {new Date(a.publishedAt).toLocaleString()}
                        </span>
                      </div>
                    </div>
                    <h2 className="dl-feature-title" style={{ marginBottom: '10px' }}>
                      {a.title}
                    </h2>
                    <SafeMarkdown content={a.body} />
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { ApiClientError, apiFetch } from '../lib/api';

type PhaseFilter = 'ALL' | 'LIVE' | 'REGISTRATION_OPEN' | 'UPCOMING' | 'COMPLETED';

interface CompetitionListItem {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: string;
  timezone: string;
  participationMode: string;
  minTeamSize: number;
  maxTeamSize: number;
  scoringMode: string;
  startsAt: string;
  endsAt: string;
  participantCount: number;
  teamCount: number;
  challengeCount: number;
}

function formatDateInTz(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: tz,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toUTCString();
  }
}

export function CompetitionsListPage() {
  const [phase, setPhase] = useState<PhaseFilter>('ALL');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [competitions, setCompetitions] = useState<CompetitionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCompetitions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (phase !== 'ALL') params.set('phase', phase);
      if (search.trim()) params.set('search', search.trim());
      params.set('page', String(page));
      params.set('limit', '12');

      const res = await apiFetch<{
        competitions: CompetitionListItem[];
        pagination: { totalPages: number };
      }>(`/api/v1/competitions?${params.toString()}`);

      setCompetitions(res.competitions);
      setTotalPages(res.pagination.totalPages);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load competitions');
    } finally {
      setLoading(false);
    }
  }, [page, phase, search]);

  useEffect(() => {
    void loadCompetitions();
  }, [loadCompetitions]);

  const phases: Array<{ key: PhaseFilter; label: string }> = [
    { key: 'ALL', label: 'ALL EVENTS' },
    { key: 'LIVE', label: 'LIVE' },
    { key: 'REGISTRATION_OPEN', label: 'REGISTRATION OPEN' },
    { key: 'UPCOMING', label: 'UPCOMING' },
    { key: 'COMPLETED', label: 'COMPLETED' },
  ];

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div className="dl-label">ARENA SCHEDULE</div>
        <h1 className="dl-section-title" style={{ marginBottom: '24px' }}>
          COMPETITIONS
        </h1>

        {error && <StatusBanner kind="error" message={error} />}

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
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {phases.map((p) => (
              <Button
                key={p.key}
                type="button"
                variant={phase === p.key ? 'gold' : 'ghost'}
                onClick={() => {
                  setPage(1);
                  setPhase(p.key);
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <div style={{ minWidth: '260px', flex: '0 1 320px' }}>
            <Input
              label="SEARCH COMPETITIONS"
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
            />
          </div>
        </div>

        {loading ? (
          <div className="dl-label">LOADING COMPETITIONS...</div>
        ) : competitions.length === 0 ? (
          <EmptyState
            title="NO COMPETITIONS MATCH YOUR FILTER"
            description="Published competitions scheduled by organizers will appear here with live registration windows."
          />
        ) : (
          <div className="dl-grid dl-grid-3">
            {competitions.map((comp) => {
              const isHighlighted = comp.status === 'LIVE' || comp.status === 'REGISTRATION_OPEN';
              return (
                <Card key={comp.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <span className={`dl-badge ${isHighlighted ? 'dl-badge-gold' : ''}`}>
                      {comp.status}
                    </span>
                    <span className="dl-label">{comp.scoringMode}</span>
                  </div>

                  <h2 className="dl-feature-title" style={{ marginTop: '14px' }}>
                    <Link to={`/competitions/${comp.slug}`}>{comp.title}</Link>
                  </h2>

                  <p style={{ color: 'var(--text-ash)', fontSize: '14px', margin: '10px 0 16px 0' }}>
                    {comp.description.length > 140
                      ? `${comp.description.slice(0, 140)}...`
                      : comp.description}
                  </p>

                  <div
                    style={{
                      borderTop: '1px solid var(--border-hairline)',
                      paddingTop: '12px',
                      marginBottom: '16px',
                      fontSize: '13px',
                    }}
                  >
                    <div>START: {formatDateInTz(comp.startsAt, comp.timezone)}</div>
                    <div style={{ color: 'var(--text-ash)' }}>
                      END: {formatDateInTz(comp.endsAt, comp.timezone)} ({comp.timezone})
                    </div>
                    <div className="dl-label" style={{ marginTop: '8px' }}>
                      {comp.participationMode} · {comp.participantCount} PARTICIPANTS · {comp.challengeCount} CHALLENGES
                    </div>
                  </div>

                  <LinkButton to={`/competitions/${comp.slug}`} variant="ghost" >
                    ENTER COMPETITION →
                  </LinkButton>
                </Card>
              );
            })}
          </div>
        )}

        {totalPages > 1 && (
          <div style={{ display: 'flex', gap: '12px', marginTop: '32px', alignItems: 'center' }}>
            <Button type="button" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              PREVIOUS
            </Button>
            <span className="dl-label">
              PAGE {page} / {totalPages}
            </span>
            <Button
              type="button"
              variant="ghost"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              NEXT
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

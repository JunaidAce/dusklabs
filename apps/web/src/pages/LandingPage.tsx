import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { AkatsukiCloud } from '../components/ui/AkatsukiCloud';
import { Sharingan } from '../components/ui/Sharingan';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';
import './LandingPage.css';

interface OverviewResponse {
  stats: {
    activeParticipants: number;
    registeredTeams: number;
    publishedChallenges: number;
    openCompetitions: number;
  };
  upcomingCompetitions: Array<{
    id: string;
    slug: string;
    title: string;
    status: string;
    participationMode: string;
    scoringMode: string;
    startsAt: string;
    endsAt: string;
  }>;
  featuredChallenges: Array<{
    id: string;
    slug: string;
    title: string;
    difficulty: string;
    points: number;
    categories: string[];
  }>;
}

export function LandingPage() {
  const { user } = useAuth();
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<OverviewResponse>('/api/v1/public/overview')
      .then((data) => {
        if (active) setOverview(data);
      })
      .catch(() => {
        if (active) setError('Unable to reach DuskLabs API telemetry.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const statItems = [
    { label: 'ACTIVE PARTICIPANTS', value: overview?.stats.activeParticipants ?? 0 },
    { label: 'REGISTERED TEAMS', value: overview?.stats.registeredTeams ?? 0 },
    { label: 'PUBLISHED CHALLENGES', value: overview?.stats.publishedChallenges ?? 0 },
    { label: 'SCHEDULED / LIVE EVENTS', value: overview?.stats.openCompetitions ?? 0 },
  ];

  return (
    <>
      <section className="dl-landing-hero">
        <div className="dl-landing-hero-clouds" aria-hidden="true">
          <AkatsukiCloud size={340} className="dl-landing-cloud dl-cloud-a" />
          <AkatsukiCloud size={230} className="dl-landing-cloud dl-cloud-b" />
          <AkatsukiCloud size={180} className="dl-landing-cloud dl-cloud-c" />
          <span className="dl-landing-kanji">暁</span>
        </div>

        <div className="dl-container dl-landing-hero-inner">
          <div className="dl-landing-hero-copy">
            <h1 className="dl-landing-hero-title">
              DUSK<span className="dl-brand-accent">LABS</span>
            </h1>

            <p className="dl-landing-lede">
              An independent Capture The Flag competition platform engineered for reproducible
              security challenges, deterministic server-side flag verification, and live team rankings.
            </p>

            <div className="dl-landing-actions">
              {user ? (
                <LinkButton to="/dashboard" variant="gold">
                  ENTER DASHBOARD
                </LinkButton>
              ) : (
                <>
                  <LinkButton to="/register" variant="gold">
                    CREATE ACCOUNT
                  </LinkButton>
                  <LinkButton to="/login" variant="ghost">
                    OPERATOR LOGIN
                  </LinkButton>
                </>
              )}
            </div>

            <div className="dl-landing-meta">
              <span>
                <span className="dl-landing-dot" /> REGISTRATION OPEN
              </span>
            </div>
          </div>

          <div className="dl-landing-emblem" aria-hidden="true">
            <Sharingan className="dl-landing-sharingan" />
          </div>
        </div>

        <div className="dl-landing-scroll">SCROLL TO ENTER THE ARENA</div>
      </section>

      <section className="dl-section dl-landing-section">
        <div className="dl-container">
          <div className="dl-landing-section-head">
            <div>
              <div className="dl-label">LIVE PLATFORM TELEMETRY</div>
              <h2 className="dl-landing-subtitle">
                WHERE <span className="dl-accent-red">CURIOSITY</span> MEETS{' '}
                <span className="dl-accent-gold">EXPLOITATION</span>
              </h2>
            </div>
            <span className="dl-landing-stamp">REAL-TIME</span>
          </div>

          {error && <StatusBanner kind="error" message={error} />}

          <div className="dl-grid dl-grid-4">
            {statItems.map((item) => (
              <Card key={item.label} className="dl-landing-stat">
                <div className="dl-label">{item.label}</div>
                <div className="dl-landing-stat-value">{loading ? '—' : item.value}</div>
                <div className="dl-landing-stat-line" />
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section id="competitions" className="dl-section dl-landing-section">
        <div className="dl-container">
          <div className="dl-landing-section-head">
            <div>
              <div className="dl-label">COMPETITION SCHEDULE</div>
              <h2 className="dl-section-title">UPCOMING &amp; LIVE EVENTS</h2>
            </div>
            <span className="dl-landing-stamp">BINGO BOOK</span>
          </div>

          {!loading && (!overview || overview.upcomingCompetitions.length === 0) ? (
            <EmptyState
              title="NO ACTIVE COMPETITIONS SCHEDULED"
              description="Competitions created and published by Competition Organizers appear here automatically."
              action={
                !user && (
                  <LinkButton to="/register" variant="ghost">
                    REGISTER FOR UPDATES
                  </LinkButton>
                )
              }
            />
          ) : (
            <div className="dl-grid dl-grid-3">
              {overview?.upcomingCompetitions.map((comp) => (
                <Card key={comp.id} className="dl-landing-event-card">
                  <div className="dl-landing-card-top">
                    <span className="dl-badge dl-badge-gold">{comp.status}</span>
                    <span className="dl-label">{comp.scoringMode} SCORING</span>
                  </div>
                  <h3 className="dl-feature-title" style={{ marginTop: '18px' }}>
                    {comp.title}
                  </h3>
                  <div className="dl-label" style={{ marginTop: '10px' }}>
                    {comp.participationMode}
                  </div>
                  <div className="dl-landing-card-rule" />
                  <p className="dl-landing-card-meta">STARTS {new Date(comp.startsAt).toUTCString()}</p>
                  <Link to={`/competitions/${comp.slug}`} className="dl-landing-card-link">
                    VIEW EVENT →
                  </Link>
                </Card>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="dl-landing-cta">
        <div className="dl-container">
          <div className="dl-landing-cta-inner">
            <div>
              <div className="dl-label">THE FINAL SEAL</div>
              <h2 className="dl-section-title" style={{ marginTop: '8px' }}>
                READY TO ENTER THE ARENA?
              </h2>
              <p className="dl-landing-cta-copy">
                Build your team, inspect verified artifacts, and climb the live leaderboard. The next
                challenge is already waiting.
              </p>
            </div>
            <div className="dl-landing-actions">
              {user ? (
                <LinkButton to="/dashboard" variant="gold">
                  ENTER DASHBOARD
                </LinkButton>
              ) : (
                <>
                  <LinkButton to="/register" variant="gold">
                    CREATE ACCOUNT
                  </LinkButton>
                  <LinkButton to="/login" variant="ghost">
                    OPERATOR LOGIN
                  </LinkButton>
                </>
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

import { LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';

export function RulesPage() {
  const sections = [
    {
      num: '01',
      title: 'FAIR PLAY & FLAG INTEGRITY',
      items: [
        'Sharing flags, solution write-ups, or unlocked hints across competing individuals or teams during an active competition is strictly prohibited.',
        'Participants may not register or compete on multiple teams within the same competition.',
        'Attempted brute-forcing of flag submission endpoints is rate-limited and audited.',
      ],
    },
    {
      num: '02',
      title: 'PLATFORM SCOPE & INFRASTRUCTURE',
      items: [
        'All DuskLabs challenges use the static Jeopardy downloadable-artifact format. Solve challenges locally on your own workstation.',
        'Do not run automated scanners, denial-of-service traffic, or exploitation payloads against DuskLabs web servers, APIs, or other participants.',
        'If you discover a platform vulnerability, submit a report via the Contact page under Security Disclosure.',
      ],
    },
    {
      num: '03',
      title: 'TEAMS, ELIGIBILITY & ROSTER LOCKS',
      items: [
        'Competitions enforce configured participation modes (INDIVIDUAL, TEAM, or HYBRID) and team size bounds.',
        'When roster locking is enabled, team memberships cannot be altered once a competition transitions to LIVE.',
        'Challenge Authors and Competition Organizers cannot earn scored solves on challenges or competitions they author or manage.',
      ],
    },
    {
      num: '04',
      title: 'SCORING, HINTS & TIE-BREAKING',
      items: [
        'Dynamic challenges decay quadratically from initialPoints toward minPoints as solve counts increase, according to the competition policy.',
        'First Blood awards bonus points (when enabled) exclusively to the first eligible solver.',
        'Hint penalties deduct atomically at unlock time and cap at remaining challenge points unless negative scores are explicitly configured.',
        'Leaderboard ties break by: (1) higher total score, (2) more solved challenges, (3) earlier last solve timestamp.',
      ],
    },
  ];

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div className="dl-label">CODE OF CONDUCT &amp; SCORING POLICY</div>
        <h1 className="dl-display-2" style={{ marginBottom: '32px' }}>
          RULES &amp; GUIDELINES
        </h1>

        <div className="dl-grid dl-grid-2">
          {sections.map((sec) => (
            <Card key={sec.num}>
              <div className="dl-label" style={{ color: 'var(--color-gold)' }}>
                SECTION {sec.num}
              </div>
              <h2 className="dl-feature-title" style={{ fontSize: '22px', margin: '8px 0 14px 0' }}>
                {sec.title}
              </h2>
              <ul style={{ margin: 0, paddingLeft: '18px', color: 'var(--text-smoke)', fontSize: '14px' }}>
                {sec.items.map((item) => (
                  <li key={item} style={{ marginBottom: '10px' }}>
                    {item}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '32px' }}>
          <LinkButton to="/competitions" variant="gold">
            BROWSE COMPETITIONS
          </LinkButton>
          <LinkButton to="/contact" variant="ghost">
            REPORT AN ISSUE OR QUESTION
          </LinkButton>
        </div>
      </div>
    </section>
  );
}

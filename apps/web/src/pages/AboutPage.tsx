import { useEffect, useState } from 'react';
import { LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { HexMark } from '../components/ui/HexMark';
import { apiFetch } from '../lib/api';

interface CategorySummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

export function AboutPage() {
  const [categories, setCategories] = useState<CategorySummary[]>([]);

  useEffect(() => {
    apiFetch<{ categories: CategorySummary[] }>('/api/v1/categories')
      .then((res) => setCategories(res.categories))
      .catch(() => {});
  }, []);

  return (
    <>
      <section className="dl-section">
        <div className="dl-container">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <HexMark size={24} />
            <span className="dl-label">PLATFORM ARCHITECTURE &amp; MISSION</span>
          </div>
          <h1 className="dl-display-2" style={{ maxWidth: '900px', marginBottom: '24px' }}>
            ABOUT DUSKLABS
          </h1>
          <p style={{ maxWidth: '720px', color: 'var(--text-smoke)', fontSize: '18px', margin: 0 }}>
            DuskLabs is an independent Jeopardy-style Capture The Flag platform built from the ground
            up for Secure Software Development. Every challenge artifact, flag verification, hint penalty,
            and leaderboard ranking is computed deterministically server-side with strict isolation and
            auditability.
          </p>
        </div>
      </section>

      <section className="dl-section">
        <div className="dl-container">
          <div className="dl-label">ENGINEERING PRINCIPLES</div>
          <h2 className="dl-section-title" style={{ marginBottom: '24px' }}>
            DESIGNED FOR INTEGRITY
          </h2>
          <div className="dl-grid dl-grid-3">
            <Card>
              <h3 className="dl-feature-title" style={{ fontSize: '20px', marginBottom: '8px' }}>
                STATIC JEOPARDY MODEL
              </h3>
              <p style={{ color: 'var(--text-ash)', fontSize: '14px', margin: 0 }}>
                Participants download SHA-256 verified artifacts inspected by our Rust attachment processor
                and solve challenges locally on their own machines—eliminating shared target interference.
              </p>
            </Card>
            <Card>
              <h3 className="dl-feature-title" style={{ fontSize: '20px', marginBottom: '8px' }}>
                TRANSACTIONAL SCORING
              </h3>
              <p style={{ color: 'var(--text-ash)', fontSize: '14px', margin: 0 }}>
                Every solve, First Blood bonus, and hint penalty writes an idempotent, immutable
                ScoreTransaction entry inside an ACID database transaction.
              </p>
            </Card>
            <Card>
              <h3 className="dl-feature-title" style={{ fontSize: '20px', marginBottom: '8px' }}>
                OWASP ASVS DEFENSES
              </h3>
              <p style={{ color: 'var(--text-ash)', fontSize: '14px', margin: 0 }}>
                Argon2id credentials, HTTP-only revocable sessions, CSRF verification, keyed HMAC/AES-256-GCM
                flag protection, and backend-enforced RBAC guard every route.
              </p>
            </Card>
          </div>
        </div>
      </section>

      <section className="dl-section" style={{ borderBottom: 'none' }}>
        <div className="dl-container">
          <div className="dl-label">CHALLENGE DOMAINS</div>
          <h2 className="dl-section-title" style={{ marginBottom: '24px' }}>
            COMPETITION CATEGORIES
          </h2>
          <div className="dl-grid dl-grid-3">
            {categories.map((cat) => (
              <Card key={cat.id}>
                <h3 className="dl-feature-title" style={{ fontSize: '18px', marginBottom: '6px' }}>
                  {cat.name}
                </h3>
                <p style={{ color: 'var(--text-ash)', fontSize: '14px', margin: 0 }}>
                  {cat.description ?? 'Security engineering and exploitation challenges.'}
                </p>
              </Card>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '32px' }}>
            <LinkButton to="/competitions" variant="gold">
              EXPLORE COMPETITIONS
            </LinkButton>
            <LinkButton to="/rules" variant="ghost">
              READ PLATFORM RULES
            </LinkButton>
            <LinkButton to="/contact" variant="ghost">
              CONTACT TEAM
            </LinkButton>
          </div>
        </div>
      </section>
    </>
  );
}

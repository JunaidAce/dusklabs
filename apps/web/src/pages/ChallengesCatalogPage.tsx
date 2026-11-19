import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Difficulties } from '@dusklabs/shared';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { ApiClientError, apiFetch } from '../lib/api';

interface CategoryItem {
  id: string;
  slug: string;
  name: string;
  challengeCount: number;
}

interface ChallengeCatalogItem {
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

export function ChallengesCatalogPage() {
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [challenges, setChallenges] = useState<ChallengeCatalogItem[]>([]);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedDifficulty, setSelectedDifficulty] = useState('');
  const [sort, setSort] = useState<'newest' | 'points_asc' | 'points_desc' | 'title'>('newest');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ categories: CategoryItem[] }>('/api/v1/categories')
      .then((res) => setCategories(res.categories))
      .catch(() => {});
  }, []);

  const fetchChallenges = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (selectedCategory) params.set('category', selectedCategory);
      if (selectedDifficulty) params.set('difficulty', selectedDifficulty);
      params.set('sort', sort);
      params.set('page', String(page));

      const data = await apiFetch<{
        challenges: ChallengeCatalogItem[];
        pagination: { totalPages: number };
      }>(`/api/v1/challenges?${params.toString()}`);

      setChallenges(data.challenges);
      setTotalPages(data.pagination.totalPages);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load challenges');
    } finally {
      setLoading(false);
    }
  }, [page, search, selectedCategory, selectedDifficulty, sort]);

  useEffect(() => {
    void fetchChallenges();
  }, [fetchChallenges]);

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div className="dl-label">JEOPARDY CHALLENGES</div>
        <h1 className="dl-section-title" style={{ marginBottom: '24px' }}>
          CHALLENGE ARCHIVE
        </h1>

        {error && <StatusBanner kind="error" message={error} />}

        <Card>
          <div className="dl-grid dl-grid-4" style={{ alignItems: 'end' }}>
            <Input
              label="SEARCH"
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
            />

            <div className="dl-field">
              <label htmlFor="cat-filter" className="dl-label">
                CATEGORY
              </label>
              <select
                id="cat-filter"
                className="dl-input"
                value={selectedCategory}
                onChange={(e) => {
                  setPage(1);
                  setSelectedCategory(e.target.value);
                }}
              >
                <option value="">ALL CATEGORIES</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.slug}>
                    {c.name.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>

            <div className="dl-field">
              <label htmlFor="diff-filter" className="dl-label">
                DIFFICULTY
              </label>
              <select
                id="diff-filter"
                className="dl-input"
                value={selectedDifficulty}
                onChange={(e) => {
                  setPage(1);
                  setSelectedDifficulty(e.target.value);
                }}
              >
                <option value="">ALL LEVELS</option>
                {Difficulties.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>

            <div className="dl-field">
              <label htmlFor="sort-filter" className="dl-label">
                SORT ORDER
              </label>
              <select
                id="sort-filter"
                className="dl-input"
                value={sort}
                onChange={(e) => setSort(e.target.value as typeof sort)}
              >
                <option value="newest">NEWEST</option>
                <option value="points_asc">POINTS: LOW TO HIGH</option>
                <option value="points_desc">POINTS: HIGH TO LOW</option>
                <option value="title">TITLE (A–Z)</option>
              </select>
            </div>
          </div>
        </Card>

        <div style={{ marginTop: '32px' }}>
          {loading ? (
            <div className="dl-label">LOADING CHALLENGES...</div>
          ) : challenges.length === 0 ? (
            <EmptyState
              title="NO ACCESSIBLE CHALLENGES FOUND"
              description="Published Jeopardy challenges matching your filters and competition eligibility appear here."
            />
          ) : (
            <div className="dl-grid dl-grid-3">
              {challenges.map((c) => (
                <Link key={c.id} to={`/challenges/${c.slug}`} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
                  <Card style={{ height: '100%', cursor: 'pointer' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="dl-badge">{c.difficulty}</span>
                      <span className="dl-caption" style={{ color: 'var(--color-gold)' }}>
                        {c.points} PTS
                      </span>
                    </div>
                    <h2 className="dl-feature-title" style={{ marginTop: '14px' }}>
                      {c.title}
                    </h2>
                    <div className="dl-label" style={{ marginTop: '6px' }}>
                      {c.categories.map((cat) => cat.name).join(' · ')}
                    </div>
                    {c.tags.length > 0 && (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '12px' }}>
                        {c.tags.map((t) => (
                          <span key={t} className="dl-badge">
                            #{t}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="dl-label" style={{ marginTop: '16px' }}>
                      {c.solveCount} SOLVES · {c.attachmentCount} ARTIFACTS
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>

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

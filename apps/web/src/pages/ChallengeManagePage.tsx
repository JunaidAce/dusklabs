import React, { useCallback, useEffect, useState } from 'react';
import { Difficulties, FlagTypes } from '@dusklabs/shared';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

interface AdminChallengeRow {
  id: string;
  slug: string;
  title: string;
  difficulty: string;
  status: 'DRAFT' | 'TESTING' | 'PUBLISHED' | 'ARCHIVED';
  isVisible: boolean;
  points: number;
  hasFlag: boolean;
  flagType: string | null;
}

interface CategoryItem {
  id: string;
  slug: string;
  name: string;
}

export function ChallengeManagePage() {
  const { user } = useAuth();
  const canCreate = user?.permissions.includes('challenge:create');

  const [rows, setRows] = useState<AdminChallengeRow[]>([]);
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [connectionInfo, setConnectionInfo] = useState('');
  const [difficulty, setDifficulty] = useState<(typeof Difficulties)[number]>('EASY');
  const [points, setPoints] = useState(100);
  const [maxAttempts, setMaxAttempts] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [flagType, setFlagType] = useState<(typeof FlagTypes)[number]>('STATIC_EXACT');
  const [flagValue, setFlagValue] = useState('');
  const [dynamicPattern, setDynamicPattern] = useState('DUSK{{{TOKEN}}}');
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [chalRes, catRes] = await Promise.all([
        apiFetch<{ challenges: AdminChallengeRow[] }>('/api/v1/admin/challenges'),
        apiFetch<{ categories: CategoryItem[] }>('/api/v1/categories'),
      ]);
      setRows(chalRes.challenges);
      setCategories(catRes.categories);
      if (!categoryId && catRes.categories[0]) {
        setCategoryId(catRes.categories[0].id);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load challenges');
    } finally {
      setLoading(false);
    }
  }, [categoryId]);

  useEffect(() => {
    if (canCreate) void loadAll();
  }, [canCreate, loadAll]);

  if (!canCreate) {
    return (
      <section className="dl-section" style={{ borderBottom: 'none' }}>
        <div className="dl-container">
          <StatusBanner kind="error" message="Authorization required: challenge:create permission missing." />
        </div>
      </section>
    );
  }

  function normalizeSlug(value: string) {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setFieldErrors({});
    setBusy(true);
    try {
      const payload = {
        slug: normalizeSlug(slug),
        title,
        description,
        connectionInfo: connectionInfo.trim() || undefined,
        difficulty,
        points: Number(points),
        initialPoints: Number(points),
        maxAttempts: Number(maxAttempts),
        isVisible,
        categoryIds: categoryId ? [categoryId] : [],
        tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
        flagConfig: flagValue.trim()
          ? {
              flagType,
              flagValue,
              dynamicPattern: flagType === 'DYNAMIC_HMAC_PATTERN' ? dynamicPattern : undefined,
            }
          : undefined,
      };
      await apiFetch('/api/v1/challenges', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setSlug('');
      setTitle('');
      setDescription('');
      setConnectionInfo('');
      setTagsText('');
      setFlagValue('');
      setMaxAttempts(0);
      setIsVisible(false);
      setNotice('Challenge created in DRAFT state with server-side flag protection.');
      await loadAll();
    } catch (err) {
      if (err instanceof ApiClientError) {
        const issues = err.issues ?? [];
        if (issues.length > 0) {
          const next: Record<string, string> = {};
          for (const issue of issues) {
            const key = issue.path?.split('.')[0] || 'form';
            next[key] = issue.message;
          }
          setFieldErrors(next);
          setError(`${err.message}${issues[0] ? `: ${issues[0].path || 'field'} - ${issues[0].message}` : ''}`);
        } else {
          setError(err.message);
        }
      } else {
        setError('Failed to create challenge');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleTransition(id: string, targetStatus: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await apiFetch(`/api/v1/challenges/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus }),
      });
      setNotice(`Challenge transitioned to ${targetStatus}.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Transition failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleVisibility(row: AdminChallengeRow) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await apiFetch(`/api/v1/challenges/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isVisible: !row.isVisible }),
      });
      setNotice(
        !row.isVisible
          ? 'Challenge marked visible to participants (when published/live as applicable).'
          : 'Challenge hidden from participants (admins can still manage it).',
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to update visibility');
    } finally {
      setBusy(false);
    }
  }

  async function handleUploadAttachment(challengeId: string, file: File) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiFetch<{ attachment?: { originalName?: string } }>(
        `/api/v1/challenges/${challengeId}/attachments`,
        { method: 'POST', body: fd },
      );
      const name = res?.attachment?.originalName ?? file.name;
      setNotice(`Attachment uploaded: ${name}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Attachment upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div className="dl-label">AUTHOR &amp; ADMIN STUDIO</div>
        <h1 className="dl-section-title" style={{ marginBottom: '24px' }}>
          CHALLENGE MANAGEMENT
        </h1>

        {error && <StatusBanner kind="error" message={error} />}
        {notice && <StatusBanner kind="success" message={notice} />}

        <div className="dl-grid dl-grid-2" style={{ alignItems: 'start' }}>
          <Card>
            <h2 className="dl-feature-title" style={{ marginBottom: '16px' }}>
              CREATE JEOPARDY CHALLENGE
            </h2>
            <form onSubmit={handleCreate}>
              <Input
                label="SLUG (LOWERCASE, HYPHENS, E.G. sharks-flag)"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                error={fieldErrors.slug}
                required
              />
              <Input label="TITLE" value={title} onChange={(e) => setTitle(e.target.value)} error={fieldErrors.title} required />

              <div className="dl-field">
                <label htmlFor="chal-desc" className="dl-label">
                  DESCRIPTION (MARKDOWN)
                </label>
                <textarea
                  id="chal-desc"
                  className="dl-input"
                  rows={4}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  required
                />
                {fieldErrors.description && (
                  <span role="alert" className="dl-field-error">
                    {fieldErrors.description}
                  </span>
                )}
              </div>

              <Input
                label="CONNECTION INFO (OPTIONAL, E.G. NC HOST PORT / URL)"
                value={connectionInfo}
                onChange={(e) => setConnectionInfo(e.target.value)}
                error={fieldErrors.connectionInfo}
              />

              <div className="dl-grid dl-grid-2">
                <div className="dl-field">
                  <label htmlFor="chal-cat" className="dl-label">
                    CATEGORY
                  </label>
                  <select
                    id="chal-cat"
                    className="dl-input"
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="dl-field">
                  <label htmlFor="chal-diff" className="dl-label">
                    DIFFICULTY
                  </label>
                  <select
                    id="chal-diff"
                    className="dl-input"
                    value={difficulty}
                    onChange={(e) => setDifficulty(e.target.value as typeof difficulty)}
                  >
                    {Difficulties.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="dl-grid dl-grid-2">
                <Input
                  label="POINTS"
                  type="number"
                  min={10}
                  max={10000}
                  value={points}
                  onChange={(e) => setPoints(Number(e.target.value))}
                  required
                />
                <Input
                  label="MAX SUBMISSION ATTEMPTS (0 = UNLIMITED)"
                  type="number"
                  min={0}
                  max={1000}
                  value={maxAttempts}
                  onChange={(e) => setMaxAttempts(Number(e.target.value))}
                  error={fieldErrors.maxAttempts}
                />
              </div>

              <Input
                label="TAGS (COMMA SEPARATED)"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
              />

              <label className="dl-label" style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '8px' }}>
                <input
                  type="checkbox"
                  checked={isVisible}
                  onChange={(e) => setIsVisible(e.target.checked)}
                />
                VISIBLE TO PARTICIPANTS WHEN PUBLISHED (UNCHECK = HIDDEN, ADMIN-ONLY)
              </label>

              <div className="dl-field">
                <label htmlFor="flag-type" className="dl-label">
                  FLAG MODE (WRITE-ONLY SERVER STORAGE)
                </label>
                <select
                  id="flag-type"
                  className="dl-input"
                  value={flagType}
                  onChange={(e) => setFlagType(e.target.value as typeof flagType)}
                >
                  {FlagTypes.map((ft) => (
                    <option key={ft} value={ft}>
                      {ft}
                    </option>
                  ))}
                </select>
              </div>

              <Input
                label={flagType === 'DYNAMIC_HMAC_PATTERN' ? 'HMAC SEED VALUE' : 'EXPECTED FLAG'}
                type="text"
                value={flagValue}
                onChange={(e) => setFlagValue(e.target.value)}
                autoComplete="off"
                error={fieldErrors.flagConfig || fieldErrors.flagValue}
              />

              {flagType === 'DYNAMIC_HMAC_PATTERN' && (
                <Input
                  label="DYNAMIC PATTERN"
                  value={dynamicPattern}
                  onChange={(e) => setDynamicPattern(e.target.value)}
                />
              )}

              <Button type="submit" disabled={busy} style={{ width: '100%' }}>
                {busy ? 'SAVING...' : 'CREATE CHALLENGE (DRAFT)'}
              </Button>
            </form>
          </Card>

          <div>
            <h2 className="dl-feature-title" style={{ marginBottom: '16px' }}>
              MANAGED CHALLENGES
            </h2>
            {loading ? (
              <div className="dl-label">LOADING...</div>
            ) : rows.length === 0 ? (
              <EmptyState
                title="NO CHALLENGES CREATED"
                description="Create a challenge in DRAFT, configure its flag, and transition it to PUBLISHED."
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {rows.map((r) => (
                  <Card key={r.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className={`dl-badge ${r.status === 'PUBLISHED' ? 'dl-badge-gold' : ''}`}>
                          {r.status}
                        </span>
                        <span className={`dl-badge ${r.isVisible ? 'dl-badge-gold' : ''}`}>
                          {r.isVisible ? 'VISIBLE' : 'HIDDEN'}
                        </span>
                      </div>
                      <span className="dl-label">
                        {r.points} PTS · {r.hasFlag ? r.flagType : 'NO FLAG'}
                      </span>
                    </div>
                    <h3 className="dl-feature-title" style={{ marginTop: '10px', fontSize: '20px' }}>
                      {r.title} <span style={{ color: 'var(--text-ash)', fontSize: '14px' }}>/{r.slug}</span>
                    </h3>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '14px' }}>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void handleToggleVisibility(r)}
                      >
                        {r.isVisible ? 'HIDE FROM PARTICIPANTS' : 'SHOW TO PARTICIPANTS'}
                      </Button>
                      {r.status !== 'TESTING' && r.status !== 'PUBLISHED' && (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void handleTransition(r.id, 'TESTING')}
                        >
                          SET TESTING
                        </Button>
                      )}
                      {(r.status === 'DRAFT' || r.status === 'TESTING') && (
                        <Button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleTransition(r.id, 'PUBLISHED')}
                        >
                          PUBLISH
                        </Button>
                      )}
                      {r.status !== 'ARCHIVED' && (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void handleTransition(r.id, 'ARCHIVED')}
                        >
                          ARCHIVE
                        </Button>
                      )}
                    </div>

                    <div
                      style={{
                        marginTop: '16px',
                        paddingTop: '14px',
                        borderTop: '1px solid var(--border-hairline)',
                        display: 'flex',
                        gap: '10px',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                      }}
                    >
                      <label className="dl-label" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <span>CHALLENGE FILE</span>
                        <input
                          type="file"
                          onChange={(e) => {
                            const file = e.target.files?.[0] ?? null;
                            if (file) {
                              void handleUploadAttachment(r.id, file);
                              e.currentTarget.value = '';
                            }
                          }}
                          disabled={busy}
                        />
                      </label>
                      <span className="dl-label">Upload a file players can download for this challenge.</span>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

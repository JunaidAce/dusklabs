import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { SafeMarkdown } from '../components/ui/SafeMarkdown';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

interface ChallengeDetail {
  id: string;
  slug: string;
  title: string;
  description: string;
  connectionInfo: string | null;
  difficulty: string;
  points: number;
  maxAttempts: number;
  solveCount: number;
  categories: Array<{ id: string; slug: string; name: string }>;
  tags: string[];
  author: { username: string; displayName: string } | null;
  competition: { slug: string; title: string; status: string } | null;
  mySolve: { solvedAt: string; pointsAwarded: number; isFirstBlood: boolean } | null;
  attemptCount: number;
}

interface AttachmentMeta {
  id: string;
  originalName: string;
  sizeBytes: number;
  sha256: string;
}

interface HintItem {
  id: string;
  sortOrder: number;
  title: string;
  costPoints: number;
  projectedCost: number;
  requiresPreviousHint: boolean;
  prerequisiteMet: boolean;
  unlocked: boolean;
  costApplied: number | null;
  effectivePointsBeforeUnlock: number;
  effectivePointsAfterUnlock: number;
  content: string | null;
}

interface HintsResponse {
  challengeBasePoints: number;
  totalPenaltiesApplied: number;
  effectivePointsCurrent: number;
  hints: HintItem[];
}

export function ChallengeDetailPage() {
  const { slug } = useParams();
  const { user } = useAuth();

  const [challenge, setChallenge] = useState<ChallengeDetail | null>(null);
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const [flagInput, setFlagInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [hintsData, setHintsData] = useState<HintsResponse | null>(null);

  const loadChallenge = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ challenge: ChallengeDetail }>(
        `/api/v1/challenges/${encodeURIComponent(slug)}`,
      );
      setChallenge(res.challenge);

      if (user) {
        const attRes = await apiFetch<{ attachments: AttachmentMeta[] }>(
          `/api/v1/challenges/${encodeURIComponent(slug)}/attachments`,
        );
        setAttachments(attRes.attachments);

        const hintsRes = await apiFetch<HintsResponse>(
          `/api/v1/challenges/${encodeURIComponent(slug)}/hints`,
        );
        setHintsData(hintsRes);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load challenge');
    } finally {
      setLoading(false);
    }
  }, [slug, user]);

  useEffect(() => {
    void loadChallenge();
  }, [loadChallenge]);

  async function handleSubmitFlag(e: React.FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{
        correct: boolean;
        message: string;
        pointsAwarded?: number;
      }>(`/api/v1/challenges/${challenge.id}/submit`, {
        method: 'POST',
        body: JSON.stringify({ flag: flagInput }),
      });

      setFlagInput('');
      setFeedback({
        kind: res.correct ? 'success' : 'error',
        text: res.correct && res.pointsAwarded ? `${res.message} (+${res.pointsAwarded} PTS)` : res.message,
      });
      await loadChallenge();
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof ApiClientError ? err.message : 'Submission failed',
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUnlockHint(hintId: string) {
    if (!challenge) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ hint: { title: string; costApplied: number } }>(
        `/api/v1/challenges/${challenge.id}/hints/${hintId}/unlock`,
        { method: 'POST' },
      );
      setFeedback({
        kind: 'success',
        text: `Unlocked "${res.hint.title}" (-${res.hint.costApplied} PTS penalty applied).`,
      });
      await loadChallenge();
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof ApiClientError ? err.message : 'Unable to unlock hint',
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="dl-container dl-section">
        <div className="dl-label">LOADING CHALLENGE BRIEF...</div>
      </div>
    );
  }

  if (error || !challenge) {
    return (
      <div className="dl-container dl-section" style={{ borderBottom: 'none' }}>
        <StatusBanner kind="error" message={error ?? 'Challenge unavailable'} />
        <LinkButton to="/challenges" variant="ghost">
          BACK TO CHALLENGES
        </LinkButton>
      </div>
    );
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container" style={{ maxWidth: '920px' }}>
        <div style={{ marginBottom: '20px' }}>
          <Link to="/challenges" className="dl-label">
            ← BACK TO CHALLENGE ARCHIVE
          </Link>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px', marginBottom: '24px' }}>
          <div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
              <span className="dl-badge">{challenge.difficulty}</span>
              {challenge.mySolve && <span className="dl-badge dl-badge-gold">SOLVED</span>}
              {challenge.mySolve?.isFirstBlood && <span className="dl-badge dl-badge-gold">FIRST BLOOD</span>}
            </div>
            <h1 className="dl-section-title">{challenge.title}</h1>
            <div className="dl-label" style={{ marginTop: '8px' }}>
              {challenge.categories.map((c) => c.name).join(' · ')}
              {challenge.author ? ` · AUTHOR: @${challenge.author.username}` : ''}
            </div>
          </div>

          <div style={{ textAlign: 'right' }}>
            <div className="dl-display-2" style={{ color: 'var(--color-gold)' }}>
              {challenge.points}
            </div>
            <div className="dl-label">POINTS · {challenge.solveCount} SOLVES</div>
          </div>
        </div>

        <Card className="dl-challenge-brief">
          <div className="dl-label" style={{ marginBottom: '12px' }}>
            CHALLENGE BRIEF
          </div>
          <SafeMarkdown content={challenge.description} />
          {challenge.connectionInfo ? (
            <div style={{ marginTop: '18px', paddingTop: '14px', borderTop: '1px solid var(--border-hairline)' }}>
              <div className="dl-label" style={{ marginBottom: '8px', color: 'var(--color-gold)' }}>
                CONNECTION INFO
              </div>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  fontSize: '14px',
                  color: 'var(--text-smoke)',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid var(--border-hairline)',
                  padding: '12px',
                  borderRadius: '6px',
                }}
              >
                {challenge.connectionInfo}
              </pre>
            </div>
          ) : null}
        </Card>

        {attachments.length > 0 && (
          <Card className="dl-attachments-box" >
            <div style={{ marginTop: '4px' }}>
              <div className="dl-label" style={{ marginBottom: '12px' }}>
                DOWNLOADABLE ARTIFACTS
              </div>
              {attachments.map((att) => (
                <div
                  key={att.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '12px',
                    padding: '12px 0',
                    borderBottom: '1px solid var(--border-hairline)',
                  }}
                >
                  <div>
                    <div>{att.originalName}</div>
                    <div className="dl-label">
                      {att.sizeBytes} BYTES · SHA256: {att.sha256.slice(0, 16)}...
                    </div>
                  </div>
                  <a
                    href={`/api/v1/attachments/${att.id}/download`}
                    className="dl-btn dl-btn-ghost"
                  >
                    DOWNLOAD ARTIFACT
                  </a>
                </div>
              ))}
            </div>
          </Card>
        )}

        {hintsData && hintsData.hints.length > 0 && (
          <div style={{ marginTop: '24px' }}>
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <span className="dl-label">HINTS &amp; PENALTIES</span>
                <span className="dl-label" style={{ color: 'var(--color-gold)' }}>
                  CURRENT EFFECTIVE POINTS: {hintsData.effectivePointsCurrent} / {hintsData.challengeBasePoints}
                </span>
              </div>
              {hintsData.hints.map((h) => (
                <div key={h.id} style={{ padding: '14px 0', borderBottom: '1px solid var(--border-hairline)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                      <strong>#{h.sortOrder} {h.title}</strong>
                      <span className="dl-badge" style={{ marginLeft: '8px' }}>
                        {h.unlocked ? `APPLIED -${h.costApplied} PTS` : `COST: ${h.costPoints} PTS`}
                      </span>
                    </div>
                    {!h.unlocked && user && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <span className="dl-label">
                          REMAINING IF UNLOCKED: {h.effectivePointsAfterUnlock} PTS
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={!h.prerequisiteMet || submitting}
                          onClick={() => void handleUnlockHint(h.id)}
                        >
                          {h.prerequisiteMet ? `UNLOCK (-${h.projectedCost} PTS)` : 'UNLOCK PREVIOUS FIRST'}
                        </Button>
                      </div>
                    )}
                  </div>
                  {h.unlocked && h.content && (
                    <div style={{ marginTop: '12px' }}>
                      <SafeMarkdown content={h.content} />
                    </div>
                  )}
                </div>
              ))}
            </Card>
          </div>
        )}

        <div style={{ marginTop: '24px' }}>
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <span className="dl-label">FLAG SUBMISSION</span>
              {challenge.maxAttempts > 0 && (
                <span className="dl-label">
                  ATTEMPTS: {challenge.attemptCount} / {challenge.maxAttempts}
                </span>
              )}
            </div>

            {feedback && <StatusBanner kind={feedback.kind} message={feedback.text} />}

            {!user ? (
              <LinkButton to="/login" variant="gold">
                SIGN IN TO SUBMIT FLAG
              </LinkButton>
            ) : challenge.mySolve ? (
              <StatusBanner
                kind="success"
                message={`Solved on ${new Date(challenge.mySolve.solvedAt).toLocaleString()} (+${challenge.mySolve.pointsAwarded} PTS).`}
              />
            ) : (
              <form onSubmit={handleSubmitFlag}>
                <Input
                  label="ENTER FLAG (E.G. DUSK{...})"
                  value={flagInput}
                  onChange={(e) => setFlagInput(e.target.value)}
                  required
                />
                <Button type="submit" disabled={submitting} style={{ width: '100%' }}>
                  {submitting ? 'VALIDATING SERVER-SIDE...' : 'SUBMIT FLAG'}
                </Button>
              </form>
            )}
          </Card>
        </div>
      </div>
    </section>
  );
}

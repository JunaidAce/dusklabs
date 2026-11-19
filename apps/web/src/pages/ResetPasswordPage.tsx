import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { resetPasswordSchema } from '@dusklabs/shared';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { ApiClientError, apiFetch } from '../lib/api';

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const [token, setToken] = useState(searchParams.get('token') ?? '');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = resetPasswordSchema.safeParse({ token, newPassword });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid input');
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch('/api/v1/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Password reset failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container" style={{ maxWidth: '520px' }}>
        <div className="dl-label">CREDENTIAL RECOVERY</div>
        <h1 className="dl-section-title" style={{ marginBottom: '24px' }}>
          RESET PASSWORD
        </h1>

        {error && <StatusBanner kind="error" message={error} />}
        {success && (
          <StatusBanner
            kind="success"
            message="Password updated and all prior sessions revoked. Sign in with your new credentials."
          />
        )}

        <Card>
          {success ? (
            <LinkButton to="/login" variant="gold">
              GO TO LOGIN
            </LinkButton>
          ) : (
            <form onSubmit={handleSubmit}>
              <Input label="RESET TOKEN" value={token} onChange={(e) => setToken(e.target.value)} required />
              <Input
                label="NEW PASSWORD (MIN 12 CHARS)"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
              <Button type="submit" disabled={submitting} style={{ width: '100%' }}>
                {submitting ? 'UPDATING...' : 'RESET PASSWORD'}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </section>
  );
}

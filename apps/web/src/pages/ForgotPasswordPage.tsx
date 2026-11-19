import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { ApiClientError, apiFetch } from '../lib/api';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch('/api/v1/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to process request');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container" style={{ maxWidth: '520px' }}>
        <div className="dl-label">CREDENTIAL RECOVERY</div>
        <h1 className="dl-section-title" style={{ marginBottom: '24px' }}>
          FORGOT PASSWORD
        </h1>

        {error && <StatusBanner kind="error" message={error} />}
        {done && (
          <StatusBanner
            kind="info"
            message="If an active account matches that email, a single-use password reset token has been issued."
          />
        )}

        <Card>
          <form onSubmit={handleSubmit}>
            <Input
              label="ACCOUNT EMAIL"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Button type="submit" disabled={submitting} style={{ width: '100%' }}>
              {submitting ? 'REQUESTING...' : 'REQUEST RESET TOKEN'}
            </Button>
          </form>
          <div className="dl-label" style={{ marginTop: '20px' }}>
            HAVE A RESET TOKEN?{' '}
            <Link to="/reset-password" style={{ color: 'var(--color-gold)' }}>
              RESET PASSWORD
            </Link>
          </div>
        </Card>
      </div>
    </section>
  );
}

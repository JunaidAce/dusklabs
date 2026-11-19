import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { ApiClientError, apiFetch } from '../lib/api';

export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const initialToken = searchParams.get('token') ?? '';
  const [token, setToken] = useState(initialToken);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState<string>('');

  async function submitToken(value: string) {
    setStatus('loading');
    setMessage('');
    try {
      await apiFetch('/api/v1/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ token: value.trim() }),
      });
      setStatus('success');
      setMessage('Email address verified. You may now sign in.');
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof ApiClientError ? err.message : 'Verification failed');
    }
  }

  useEffect(() => {
    if (initialToken.length >= 32) {
      void submitToken(initialToken);
    }
  }, [initialToken]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void submitToken(token);
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container" style={{ maxWidth: '520px' }}>
        <div className="dl-label">ACCOUNT VERIFICATION</div>
        <h1 className="dl-section-title" style={{ marginBottom: '24px' }}>
          VERIFY EMAIL
        </h1>

        {status === 'success' && <StatusBanner kind="success" message={message} />}
        {status === 'error' && <StatusBanner kind="error" message={message} />}

        <Card>
          {status === 'success' ? (
            <LinkButton to="/login" variant="gold">
              PROCEED TO LOGIN
            </LinkButton>
          ) : (
            <form onSubmit={handleSubmit}>
              <Input
                label="VERIFICATION TOKEN"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
              />
              <Button type="submit" disabled={status === 'loading'} style={{ width: '100%' }}>
                {status === 'loading' ? 'VERIFYING...' : 'VERIFY TOKEN'}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </section>
  );
}

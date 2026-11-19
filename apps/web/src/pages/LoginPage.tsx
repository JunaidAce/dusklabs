import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError } from '../lib/api';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(identifier, password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to sign in');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container" style={{ maxWidth: '520px' }}>
        <div className="dl-label">OPERATOR ACCESS</div>
        <h1 className="dl-section-title" style={{ marginBottom: '24px' }}>
          SIGN IN
        </h1>

        {error && <StatusBanner kind="error" message={error} />}

        <Card>
          <form onSubmit={handleSubmit} noValidate>
            <Input
              label="USERNAME OR EMAIL"
              type="text"
              autoComplete="username"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
            <Input
              label="PASSWORD"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <Button type="submit" disabled={submitting} style={{ width: '100%', marginTop: '8px' }}>
              {submitting ? 'AUTHENTICATING...' : 'LOGIN'}
            </Button>
          </form>

          <div
            style={{
              marginTop: '24px',
              paddingTop: '16px',
              borderTop: '1px solid var(--border-hairline)',
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '12px',
              letterSpacing: '0.96px',
              textTransform: 'uppercase',
            }}
          >
            <Link to="/forgot-password">FORGOT PASSWORD</Link>
            <Link to="/register" style={{ color: 'var(--color-gold)' }}>
              CREATE ACCOUNT
            </Link>
          </div>
        </Card>
      </div>
    </section>
  );
}

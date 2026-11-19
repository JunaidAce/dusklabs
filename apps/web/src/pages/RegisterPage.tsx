import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { registerSchema } from '@dusklabs/shared';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { ApiClientError, apiFetch } from '../lib/api';

export function RegisterPage() {
  const [form, setForm] = useState({
    username: '',
    displayName: '',
    email: '',
    country: '',
    registrationCode: '',
    password: '',
  });
  const [codeRequired, setCodeRequired] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [successEmail, setSuccessEmail] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    apiFetch<{ settings: { registrationCodeRequired?: boolean } }>('/api/v1/settings/public')
      .then((res) => {
        if (active) setCodeRequired(Boolean(res.settings.registrationCodeRequired));
      })
      .catch(() => {
        // Settings are advisory for the form; the API enforces the code on submit.
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});
    setServerError(null);

    const payload = {
      ...form,
      country: form.country.trim() ? form.country.trim().toUpperCase() : undefined,
      registrationCode: form.registrationCode.trim() || undefined,
    };

    const parsed = registerSchema.safeParse(payload);
    if (!parsed.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        nextErrors[key] = issue.message;
      }
      setFieldErrors(nextErrors);
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      });
      setSuccessEmail(parsed.data.email);
    } catch (err) {
      setServerError(err instanceof ApiClientError ? err.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container" style={{ maxWidth: '560px' }}>
        <div className="dl-label">NEW OPERATOR</div>
        <h1 className="dl-section-title" style={{ marginBottom: '24px' }}>
          REGISTER
        </h1>

        {serverError && <StatusBanner kind="error" message={serverError} />}

        {successEmail ? (
          <Card>
            <StatusBanner
              kind="success"
              message={`Account created for ${successEmail}. You can sign in now.`}
            />
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <LinkButton to="/login" variant="gold">
                SIGN IN
              </LinkButton>
            </div>
          </Card>
        ) : (
          <Card>
            <form onSubmit={handleSubmit} noValidate>
              <Input
                label="USERNAME (3-24 CHARS)"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                error={fieldErrors.username}
                required
              />
              <Input
                label="DISPLAY NAME"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                error={fieldErrors.displayName}
                required
              />
              <Input
                label="EMAIL ADDRESS"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                error={fieldErrors.email}
                required
              />
              <Input
                label="COUNTRY CODE (OPTIONAL, E.G. US)"
                maxLength={2}
                value={form.country}
                onChange={(e) => setForm({ ...form, country: e.target.value })}
                error={fieldErrors.country}
              />
              {codeRequired && (
                <Input
                  label="REGISTRATION CODE"
                  value={form.registrationCode}
                  onChange={(e) => setForm({ ...form, registrationCode: e.target.value })}
                  error={fieldErrors.registrationCode}
                  autoComplete="off"
                  required
                />
              )}
              <Input
                label="PASSWORD (MIN 12 CHARS)"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                error={fieldErrors.password}
                required
              />
              <Button type="submit" disabled={submitting} style={{ width: '100%', marginTop: '8px' }}>
                {submitting ? 'CREATING ACCOUNT...' : 'CREATE ACCOUNT'}
              </Button>
            </form>
            <div className="dl-label" style={{ marginTop: '20px' }}>
              ALREADY REGISTERED?{' '}
              <Link to="/login" style={{ color: 'var(--color-gold)' }}>
                SIGN IN
              </Link>
            </div>
          </Card>
        )}
      </div>
    </section>
  );
}

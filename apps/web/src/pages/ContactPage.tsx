import React, { useCallback, useEffect, useState } from 'react';
import { ContactCategories, createContactInquirySchema } from '@dusklabs/shared';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

interface MyInquiry {
  id: string;
  category: string;
  subject: string;
  status: string;
  createdAt: string;
}

export function ContactPage() {
  const { user } = useAuth();
  const [name, setName] = useState(user?.displayName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [category, setCategory] = useState<(typeof ContactCategories)[number]>('GENERAL');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [website, setWebsite] = useState(''); // Honeypot

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [myInquiries, setMyInquiries] = useState<MyInquiry[]>([]);

  useEffect(() => {
    if (user) {
      setName((prev) => prev || user.displayName);
      setEmail((prev) => prev || user.email);
    }
  }, [user]);

  const loadMyInquiries = useCallback(async () => {
    if (!user) {
      setMyInquiries([]);
      return;
    }
    try {
      const res = await apiFetch<{ inquiries: MyInquiry[] }>('/api/v1/contact/my');
      setMyInquiries(res.inquiries);
    } catch {
      // Non-blocking
    }
  }, [user]);

  useEffect(() => {
    void loadMyInquiries();
  }, [loadMyInquiries]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});
    setServerError(null);
    setSuccessId(null);

    const parsed = createContactInquirySchema.safeParse({
      name,
      email,
      category,
      subject,
      message,
      website: website || undefined,
    });

    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        errs[key] = issue.message;
      }
      setFieldErrors(errs);
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{ inquiry: { id: string } }>('/api/v1/contact', {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      });
      setSuccessId(res.inquiry.id);
      setSubject('');
      setMessage('');
      await loadMyInquiries();
    } catch (err) {
      setServerError(err instanceof ApiClientError ? err.message : 'Unable to send inquiry');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div className="dl-label">SUPPORT &amp; SECURITY DISCLOSURE</div>
        <h1 className="dl-display-2" style={{ marginBottom: '24px' }}>
          CONTACT DUSKLABS
        </h1>

        {serverError && <StatusBanner kind="error" message={serverError} />}
        {successId && (
          <StatusBanner
            kind="success"
            message={`Inquiry received (Reference ID: ${successId}). Authorized moderators will review your request.`}
          />
        )}

        <div className="dl-grid dl-grid-2" style={{ alignItems: 'start' }}>
          <Card>
            <h2 className="dl-feature-title" style={{ fontSize: '22px', marginBottom: '16px' }}>
              SUBMIT AN INQUIRY
            </h2>
            <form onSubmit={handleSubmit} noValidate>
              <Input
                label="YOUR NAME"
                value={name}
                onChange={(e) => setName(e.target.value)}
                error={fieldErrors.name}
                required
              />
              <Input
                label="EMAIL ADDRESS"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                error={fieldErrors.email}
                required
              />

              <div className="dl-field">
                <label htmlFor="contact-cat" className="dl-label">
                  INQUIRY CATEGORY
                </label>
                <select
                  id="contact-cat"
                  className="dl-input"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as typeof category)}
                >
                  {ContactCategories.map((c) => (
                    <option key={c} value={c}>
                      {c.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>

              <Input
                label="SUBJECT"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                error={fieldErrors.subject}
                required
              />

              <div className="dl-field">
                <label htmlFor="contact-msg" className="dl-label">
                  MESSAGE (MIN 15 CHARS)
                </label>
                <textarea
                  id="contact-msg"
                  className="dl-input"
                  rows={5}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  required
                />
                {fieldErrors.message && (
                  <span role="alert" className="dl-field-error">
                    {fieldErrors.message}
                  </span>
                )}
              </div>

              {/* Hidden anti-spam honeypot */}
              <div style={{ position: 'absolute', left: '-9999px' }} aria-hidden="true">
                <input
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>

              <Button type="submit" disabled={submitting} style={{ width: '100%' }}>
                {submitting ? 'TRANSMITTING...' : 'SEND INQUIRY'}
              </Button>
            </form>
          </Card>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <Card>
              <div className="dl-label">INQUIRY CHANNELS</div>
              <h2 className="dl-feature-title" style={{ fontSize: '20px', margin: '8px 0 12px 0' }}>
                ROUTING GUIDELINES
              </h2>
              <p style={{ color: 'var(--text-ash)', fontSize: '14px', margin: '0 0 12px 0' }}>
                Select <strong>SECURITY DISCLOSURE</strong> for platform vulnerabilities,{' '}
                <strong>COMPETITION</strong> for event scheduling or rule clarifications, and{' '}
                <strong>ACCOUNT SUPPORT</strong> for verification or team issues.
              </p>
              <div className="dl-label">
                SUBMISSIONS ARE RATE-LIMITED AND REVIEWED ONLY BY AUTHORIZED MODERATORS &amp; ADMINS.
              </div>
            </Card>

            {user && (
              <Card>
                <div className="dl-label" style={{ marginBottom: '12px' }}>
                  YOUR SUBMITTED INQUIRIES
                </div>
                {myInquiries.length === 0 ? (
                  <div className="dl-label">NO PREVIOUS INQUIRIES RECORDED</div>
                ) : (
                  myInquiries.map((inq) => (
                    <div
                      key={inq.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 0',
                        borderBottom: '1px solid var(--border-hairline)',
                      }}
                    >
                      <div>
                        <div>{inq.subject}</div>
                        <div className="dl-label">
                          {inq.category} · {new Date(inq.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                      <span className={`dl-badge ${inq.status === 'RESOLVED' ? 'dl-badge-gold' : ''}`}>
                        {inq.status}
                      </span>
                    </div>
                  ))
                )}
              </Card>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

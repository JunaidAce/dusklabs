import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

interface PlatformSettingsDto {
  platformName: string;
  tagline: string;
  registrationEnabled: boolean;
  registrationCodeSet: boolean;
  requireEmailVerificationForLogin: boolean;
  teamCreationEnabled: boolean;
  defaultMaxTeamSize: number;
  flagSubmissionMaxAttemptsPerMin: number;
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
  contactFormEnabled: boolean;
  scoreboardVisible: boolean;
  challengesVisible: boolean;
  updatedAt: string;
  updatedBy: { username: string } | null;
}

export function AdminSettingsPage() {
  const { user } = useAuth();
  const canManage = Boolean(user?.permissions.includes('platform:settings:manage'));

  const [form, setForm] = useState<PlatformSettingsDto | null>(null);
  const [registrationCode, setRegistrationCode] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canManage) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ settings: PlatformSettingsDto }>('/api/v1/admin/settings');
      setForm(res.settings);
      setRegistrationCode('');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load settings');
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canManage) {
    return (
      <section className="dl-section" style={{ borderBottom: 'none' }}>
        <div className="dl-container">
          <StatusBanner
            kind="error"
            message="Authorization required: platform:settings:manage is restricted to Super Administrators."
          />
        </div>
      </section>
    );
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{ settings: PlatformSettingsDto }>('/api/v1/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          platformName: form.platformName,
          tagline: form.tagline,
          registrationEnabled: form.registrationEnabled,
          ...(registrationCode.trim() ? { registrationCode: registrationCode.trim() } : {}),
          requireEmailVerificationForLogin: form.requireEmailVerificationForLogin,
          teamCreationEnabled: form.teamCreationEnabled,
          defaultMaxTeamSize: Number(form.defaultMaxTeamSize),
          flagSubmissionMaxAttemptsPerMin: Number(form.flagSubmissionMaxAttemptsPerMin),
          maintenanceMode: form.maintenanceMode,
          maintenanceMessage: form.maintenanceMessage || null,
          contactFormEnabled: form.contactFormEnabled,
          scoreboardVisible: form.scoreboardVisible,
          challengesVisible: form.challengesVisible,
        }),
      });
      setForm(res.settings);
      setRegistrationCode('');
      setNotice('Platform settings saved and recorded in audit log.');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to save settings');
    } finally {
      setBusy(false);
    }
  }

  async function handleClearCode() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{ settings: PlatformSettingsDto }>('/api/v1/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({ registrationCode: null }),
      });
      setForm(res.settings);
      setRegistrationCode('');
      setNotice('Stored registration code cleared.');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to clear registration code');
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{ settings: PlatformSettingsDto }>('/api/v1/admin/settings/reset', {
        method: 'POST',
      });
      setForm(res.settings);
      setConfirmReset(false);
      setRegistrationCode('');
      setNotice('Platform settings restored to defaults.');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to reset settings');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container" style={{ maxWidth: '880px' }}>
        <div className="dl-label">SUPER ADMINISTRATOR CONFIGURATION</div>
        <h1 className="dl-section-title" style={{ marginBottom: '24px' }}>
          PLATFORM SETTINGS
        </h1>

        {error && <StatusBanner kind="error" message={error} />}
        {notice && <StatusBanner kind="success" message={notice} />}

        {loading || !form ? (
          <div className="dl-label">LOADING PLATFORM SETTINGS...</div>
        ) : (
          <Card>
            <form onSubmit={handleSave}>
              <div className="dl-grid dl-grid-2">
                <Input
                  label="PLATFORM NAME"
                  value={form.platformName}
                  onChange={(e) => setForm({ ...form, platformName: e.target.value })}
                  required
                />
                <Input
                  label="TAGLINE"
                  value={form.tagline}
                  onChange={(e) => setForm({ ...form, tagline: e.target.value })}
                  required
                />
              </div>

              <div className="dl-grid dl-grid-2">
                <Input
                  label="DEFAULT MAX TEAM SIZE"
                  type="number"
                  min={1}
                  max={50}
                  value={form.defaultMaxTeamSize}
                  onChange={(e) => setForm({ ...form, defaultMaxTeamSize: Number(e.target.value) })}
                />
                <Input
                  label="FLAG RATE LIMIT (PER MIN)"
                  type="number"
                  min={1}
                  max={120}
                  value={form.flagSubmissionMaxAttemptsPerMin}
                  onChange={(e) =>
                    setForm({ ...form, flagSubmissionMaxAttemptsPerMin: Number(e.target.value) })
                  }
                />
              </div>

              <Input
                label={`REGISTRATION CODE (${form.registrationCodeSet ? 'CURRENTLY SET' : 'NOT SET'})`}
                value={registrationCode}
                onChange={(e) => setRegistrationCode(e.target.value)}
                placeholder={
                  form.registrationCodeSet
                    ? 'Enter a new code to replace the current one'
                    : 'Optional, minimum 8 characters'
                }
                autoComplete="off"
              />
              <div className="dl-label" style={{ marginTop: '-8px', marginBottom: '16px' }}>
                CODES ARE STORED AS HASHES AND NEVER DISPLAYED AGAIN. WHEN SET, NEW ACCOUNTS MUST
                PROVIDE THIS CODE.
                {form.registrationCodeSet && (
                  <button
                    type="button"
                    onClick={handleClearCode}
                    disabled={busy}
                    style={{
                      display: 'block',
                      marginTop: '10px',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      color: 'var(--color-red-soft)',
                      cursor: 'pointer',
                      font: 'inherit',
                      letterSpacing: 'inherit',
                    }}
                  >
                    CLEAR STORED REGISTRATION CODE
                  </button>
                )}
              </div>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  margin: '16px 0 24px 0',
                  padding: '16px',
                  border: '1px solid var(--border-hairline)',
                  background: 'var(--color-black)',
                }}
              >
                {[
                  { key: 'registrationEnabled', label: 'ALLOW NEW USER REGISTRATIONS' },
                  {
                    key: 'requireEmailVerificationForLogin',
                    label: 'REQUIRE EMAIL VERIFICATION BEFORE LOGIN',
                  },
                  { key: 'teamCreationEnabled', label: 'ALLOW PARTICIPANT TEAM CREATION' },
                  { key: 'contactFormEnabled', label: 'ENABLE PUBLIC CONTACT INQUIRY FORM' },
                  { key: 'scoreboardVisible', label: 'SHOW SCOREBOARD TO EVERYONE' },
                  { key: 'challengesVisible', label: 'SHOW CHALLENGES TO EVERYONE' },
                  { key: 'maintenanceMode', label: 'MAINTENANCE NOTICE MODE' },
                ].map((toggle) => (
                  <label
                    key={toggle.key}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    <span className="dl-label" style={{ color: 'var(--color-white)' }}>
                      {toggle.label}
                    </span>
                    <input
                      type="checkbox"
                      checked={Boolean((form as any)[toggle.key])}
                      onChange={(e) => setForm({ ...form, [toggle.key]: e.target.checked })}
                    />
                  </label>
                ))}
              </div>

              {form.maintenanceMode && (
                <Input
                  label="MAINTENANCE BANNER MESSAGE"
                  value={form.maintenanceMessage ?? ''}
                  onChange={(e) => setForm({ ...form, maintenanceMessage: e.target.value })}
                />
              )}

              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                <Button type="submit" variant="gold" disabled={busy}>
                  {busy ? 'SAVING...' : 'SAVE SETTINGS'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmReset(true)}
                >
                  RESET TO DEFAULTS
                </Button>
              </div>
            </form>

            {confirmReset && (
              <div style={{ marginTop: '20px', padding: '16px', border: '1px solid var(--color-gold)' }}>
                <div className="dl-label" style={{ color: 'var(--color-gold)', marginBottom: '8px' }}>
                  CONFIRM RESET TO PLATFORM DEFAULTS?
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Button type="button" variant="gold" disabled={busy} onClick={() => void handleReset()}>
                    CONFIRM RESET
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setConfirmReset(false)}>
                    CANCEL
                  </Button>
                </div>
              </div>
            )}

            <div className="dl-label" style={{ marginTop: '20px' }}>
              LAST UPDATED: {new Date(form.updatedAt).toLocaleString()}
              {form.updatedBy ? ` BY @${form.updatedBy.username}` : ''}
            </div>
          </Card>
        )}
      </div>
    </section>
  );
}

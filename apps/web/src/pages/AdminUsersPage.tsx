import { useCallback, useEffect, useState } from 'react';
import { AccountStatuses, RoleNames } from '@dusklabs/shared';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

interface AdminUserRow {
  id: string;
  username: string;
  displayName: string;
  email: string;
  accountStatus: string;
  suspendedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  roles: string[];
  solveCount: number;
}

interface AdminUserDetail {
  id: string;
  username: string;
  displayName: string;
  email: string;
  accountStatus: string;
  suspendedUntil: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  roles: string[];
  activeSessionCount: number;
  totalPoints: number;
  solveCount: number;
  teams: Array<{ id: string; name: string; memberRole: string }>;
  competitions: Array<{ registrationId: string; status: string; competition: { title: string } }>;
  moderationHistory: Array<{
    id: string;
    action: string;
    previousStatus: string;
    newStatus: string;
    reason: string;
    createdAt: string;
    actor: { username: string } | null;
  }>;
}

export function AdminUsersPage() {
  const { user } = useAuth();
  const canManageUsers = Boolean(user?.permissions.includes('user:manage'));
  const canAssignRoles = Boolean(user?.permissions.includes('admin:roles:assign'));

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [selectedUser, setSelectedUser] = useState<AdminUserDetail | null>(null);
  const [reason, setReason] = useState('');
  const [suspendUntil, setSuspendUntil] = useState('');
  const [roleToAssign, setRoleToAssign] = useState<(typeof RoleNames)[number]>('CHALLENGE_AUTHOR');
  const [pendingAction, setPendingAction] = useState<'SUSPEND' | 'BAN' | 'RESTORE' | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    if (!canManageUsers) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter) params.set('status', statusFilter);
      if (roleFilter) params.set('role', roleFilter);
      params.set('page', String(page));

      const res = await apiFetch<{
        users: AdminUserRow[];
        pagination: { totalPages: number };
      }>(`/api/v1/admin/users?${params.toString()}`);
      setUsers(res.users);
      setTotalPages(res.pagination.totalPages);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load users');
    } finally {
      setLoading(false);
    }
  }, [canManageUsers, page, roleFilter, search, statusFilter]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function inspectUser(userId: string) {
    setError(null);
    setPendingAction(null);
    try {
      const res = await apiFetch<{ user: AdminUserDetail }>(`/api/v1/admin/users/${userId}`);
      setSelectedUser(res.user);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load user details');
    }
  }

  async function executeStatusAction() {
    if (!selectedUser || !pendingAction) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (pendingAction === 'SUSPEND') {
        await apiFetch(`/api/v1/admin/users/${selectedUser.id}/suspend`, {
          method: 'POST',
          body: JSON.stringify({
            reason,
            expiresAt: suspendUntil ? new Date(suspendUntil).toISOString() : null,
          }),
        });
      } else if (pendingAction === 'BAN') {
        await apiFetch(`/api/v1/admin/users/${selectedUser.id}/ban`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
      } else {
        await apiFetch(`/api/v1/admin/users/${selectedUser.id}/restore`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
      }
      setNotice(`Account action ${pendingAction} applied to @${selectedUser.username}.`);
      setReason('');
      setSuspendUntil('');
      setPendingAction(null);
      await Promise.all([loadUsers(), inspectUser(selectedUser.id)]);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleAssignRole() {
    if (!selectedUser) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/admin/users/${selectedUser.id}/roles`, {
        method: 'POST',
        body: JSON.stringify({ roleName: roleToAssign }),
      });
      setNotice(`Assigned role ${roleToAssign} to @${selectedUser.username}.`);
      await Promise.all([loadUsers(), inspectUser(selectedUser.id)]);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Role assignment failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeRole(roleName: string) {
    if (!selectedUser) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/admin/users/${selectedUser.id}/roles/${roleName}`, {
        method: 'DELETE',
      });
      setNotice(`Revoked role ${roleName} from @${selectedUser.username}.`);
      await Promise.all([loadUsers(), inspectUser(selectedUser.id)]);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Role revocation failed');
    } finally {
      setBusy(false);
    }
  }

  if (!canManageUsers) {
    return (
      <section className="dl-section" style={{ borderBottom: 'none' }}>
        <div className="dl-container">
          <StatusBanner kind="error" message="Authorization required: user:manage permission missing." />
        </div>
      </section>
    );
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div className="dl-label">SECURITY &amp; ACCESS ADMINISTRATION</div>
        <h1 className="dl-section-title" style={{ marginBottom: '24px' }}>
          USER &amp; ROLE MANAGEMENT
        </h1>

        {error && <StatusBanner kind="error" message={error} />}
        {notice && <StatusBanner kind="success" message={notice} />}

        <Card>
          <div className="dl-grid dl-grid-3" style={{ alignItems: 'end' }}>
            <Input
              label="SEARCH (USERNAME, EMAIL, OR USER ID)"
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
            />

            <div className="dl-field">
              <label htmlFor="usr-status" className="dl-label">
                ACCOUNT STATUS
              </label>
              <select
                id="usr-status"
                className="dl-input"
                value={statusFilter}
                onChange={(e) => {
                  setPage(1);
                  setStatusFilter(e.target.value);
                }}
              >
                <option value="">ALL STATUSES</option>
                {AccountStatuses.filter((s) => s !== 'DELETED').map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="dl-field">
              <label htmlFor="usr-role" className="dl-label">
                ROLE FILTER
              </label>
              <select
                id="usr-role"
                className="dl-input"
                value={roleFilter}
                onChange={(e) => {
                  setPage(1);
                  setRoleFilter(e.target.value);
                }}
              >
                <option value="">ALL ROLES</option>
                {RoleNames.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Card>

        <div style={{ marginTop: '24px' }}>
          {loading ? (
            <div className="dl-label">LOADING USERS...</div>
          ) : users.length === 0 ? (
            <EmptyState
              title="NO USERS MATCH FILTERS"
              description="Adjust your search query or account status filters."
            />
          ) : (
            <Card>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--text-ash)' }}>
                      <th className="dl-label" style={{ padding: '10px 8px' }}>USER</th>
                      <th className="dl-label" style={{ padding: '10px 8px' }}>STATUS</th>
                      <th className="dl-label" style={{ padding: '10px 8px' }}>ROLES</th>
                      <th className="dl-label" style={{ padding: '10px 8px' }}>REGISTERED</th>
                      <th className="dl-label" style={{ padding: '10px 8px' }}>LAST LOGIN</th>
                      <th className="dl-label" style={{ padding: '10px 8px' }}>ACTION</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                        <td style={{ padding: '12px 8px' }}>
                          <div>@{u.username}</div>
                          <div className="dl-label">{u.email}</div>
                        </td>
                        <td style={{ padding: '12px 8px' }}>
                          <span className={`dl-badge ${u.accountStatus === 'ACTIVE' ? 'dl-badge-gold' : ''}`}>
                            {u.accountStatus}
                          </span>
                        </td>
                        <td style={{ padding: '12px 8px', fontSize: '12px' }}>
                          {u.roles.join(', ')}
                        </td>
                        <td style={{ padding: '12px 8px', fontSize: '13px', color: 'var(--text-ash)' }}>
                          {new Date(u.createdAt).toLocaleDateString()}
                        </td>
                        <td style={{ padding: '12px 8px', fontSize: '13px', color: 'var(--text-ash)' }}>
                          {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'NEVER'}
                        </td>
                        <td style={{ padding: '12px 8px' }}>
                          <Button type="button" variant="ghost" onClick={() => void inspectUser(u.id)}>
                            INSPECT
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div style={{ display: 'flex', gap: '12px', marginTop: '16px', alignItems: 'center' }}>
                  <Button type="button" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    PREVIOUS
                  </Button>
                  <span className="dl-label">
                    PAGE {page} / {totalPages}
                  </span>
                  <Button type="button" variant="ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                    NEXT
                  </Button>
                </div>
              )}
            </Card>
          )}
        </div>

        {/* Selected User Inspector */}
        {selectedUser && (
          <div style={{ marginTop: '32px' }}>
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
                <div>
                  <div className="dl-label">USER DOSSIER · ID: {selectedUser.id}</div>
                  <h2 className="dl-feature-title">
                    @{selectedUser.username} ({selectedUser.accountStatus})
                  </h2>
                </div>
                <Button type="button" variant="ghost" onClick={() => setSelectedUser(null)}>
                  CLOSE PANEL
                </Button>
              </div>

              <div className="dl-grid dl-grid-2" style={{ alignItems: 'start' }}>
                <div>
                  <div className="dl-label" style={{ marginBottom: '8px' }}>
                    ACCOUNT TELEMETRY
                  </div>
                  <p style={{ fontSize: '14px', color: 'var(--text-smoke)', margin: '0 0 12px 0' }}>
                    POINTS: {selectedUser.totalPoints} · SOLVES: {selectedUser.solveCount} · ACTIVE SESSIONS:{' '}
                    {selectedUser.activeSessionCount}
                  </p>
                  <div className="dl-label" style={{ marginBottom: '8px' }}>
                    ROLES
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
                    {selectedUser.roles.map((r) => (
                      <div key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        <span className="dl-badge dl-badge-gold">{r}</span>
                        {canAssignRoles && r !== 'PARTICIPANT' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRevokeRole(r)}
                            style={{
                              background: 'transparent',
                              border: '1px solid var(--text-ash)',
                              color: 'var(--color-white)',
                              cursor: 'pointer',
                              fontSize: '10px',
                              padding: '2px 6px',
                            }}
                          >
                            REVOKE
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  {canAssignRoles && (
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'end', marginBottom: '20px' }}>
                      <div className="dl-field" style={{ flex: 1, marginBottom: 0 }}>
                        <label htmlFor="assign-role" className="dl-label">
                          ASSIGN ROLE
                        </label>
                        <select
                          id="assign-role"
                          className="dl-input"
                          value={roleToAssign}
                          onChange={(e) => setRoleToAssign(e.target.value as typeof roleToAssign)}
                        >
                          {RoleNames.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </div>
                      <Button type="button" disabled={busy} onClick={() => void handleAssignRole()}>
                        GRANT ROLE
                      </Button>
                    </div>
                  )}
                </div>

                <div>
                  <div className="dl-label" style={{ marginBottom: '8px' }}>
                    MODERATION ACTIONS
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
                    {selectedUser.accountStatus === 'ACTIVE' && (
                      <>
                        <Button type="button" variant="ghost" onClick={() => setPendingAction('SUSPEND')}>
                          SUSPEND ACCOUNT
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setPendingAction('BAN')}>
                          BAN ACCOUNT
                        </Button>
                      </>
                    )}
                    {(selectedUser.accountStatus === 'SUSPENDED' ||
                      selectedUser.accountStatus === 'BANNED') && (
                      <Button type="button" variant="gold" onClick={() => setPendingAction('RESTORE')}>
                        RESTORE ACCOUNT
                      </Button>
                    )}
                  </div>

                  {pendingAction && (
                    <div style={{ border: '1px solid var(--color-gold)', padding: '16px', marginBottom: '16px' }}>
                      <div className="dl-label" style={{ color: 'var(--color-gold)', marginBottom: '8px' }}>
                        CONFIRM {pendingAction} ACTION FOR @{selectedUser.username}
                      </div>
                      <Input
                        label="MANDATORY AUDIT REASON (MIN 5 CHARS)"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        required
                      />
                      {pendingAction === 'SUSPEND' && (
                        <Input
                          label="OPTIONAL EXPIRATION (LOCAL DATE/TIME)"
                          type="datetime-local"
                          value={suspendUntil}
                          onChange={(e) => setSuspendUntil(e.target.value)}
                        />
                      )}
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <Button
                          type="button"
                          disabled={busy || reason.trim().length < 5}
                          onClick={() => void executeStatusAction()}
                        >
                          {busy ? 'PROCESSING...' : `CONFIRM ${pendingAction}`}
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setPendingAction(null)}>
                          CANCEL
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="dl-label" style={{ marginBottom: '8px' }}>
                    MODERATION HISTORY
                  </div>
                  {selectedUser.moderationHistory.length === 0 ? (
                    <div className="dl-label">NO MODERATION ACTIONS RECORDED</div>
                  ) : (
                    selectedUser.moderationHistory.map((m) => (
                      <div
                        key={m.id}
                        style={{
                          padding: '8px 0',
                          borderBottom: '1px solid var(--border-hairline)',
                          fontSize: '13px',
                        }}
                      >
                        <div>
                          <strong>{m.action}</strong> ({m.previousStatus} → {m.newStatus})
                        </div>
                        <div className="dl-label">
                          {m.reason} · {m.actor ? `BY @${m.actor.username}` : 'SYSTEM'} ·{' '}
                          {new Date(m.createdAt).toLocaleString()}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>
    </section>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import { AuditCategories } from '@dusklabs/shared';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { ApiClientError, apiFetch } from '../lib/api';

interface AuditLogRow {
  id: string;
  category: string;
  action: string;
  actor: { id: string; username: string; displayName: string } | null;
  actorRole: string | null;
  entityType: string;
  entityId: string | null;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  correlationId: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export function AdminAuditLogsPage() {
  const { user } = useAuth();
  const canViewAudit = Boolean(user?.permissions.includes('audit:logs:read'));

  const [actor, setActor] = useState('');
  const [category, setCategory] = useState('');
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [selected, setSelected] = useState<AuditLogRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadLogs = useCallback(async () => {
    if (!canViewAudit) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (actor.trim()) params.set('actor', actor.trim());
      if (category) params.set('category', category);
      if (action.trim()) params.set('action', action.trim());
      if (entityType.trim()) params.set('entityType', entityType.trim());
      if (entityId.trim()) params.set('entityId', entityId.trim());
      if (startDate) params.set('startDate', new Date(startDate).toISOString());
      if (endDate) params.set('endDate', new Date(endDate).toISOString());
      params.set('page', String(page));
      params.set('limit', '25');

      const res = await apiFetch<{
        logs: AuditLogRow[];
        pagination: { totalPages: number };
      }>(`/api/v1/admin/audit-logs?${params.toString()}`);

      setLogs(res.logs);
      setTotalPages(res.pagination.totalPages);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load audit logs');
    } finally {
      setLoading(false);
    }
  }, [action, actor, canViewAudit, category, endDate, entityId, entityType, page, startDate]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  function handleResetFilters() {
    setActor('');
    setCategory('');
    setAction('');
    setEntityType('');
    setEntityId('');
    setStartDate('');
    setEndDate('');
    setPage(1);
  }

  if (!canViewAudit) {
    return (
      <section className="dl-section" style={{ borderBottom: 'none' }}>
        <div className="dl-container">
          <StatusBanner kind="error" message="Authorization required: audit:logs:read permission missing." />
        </div>
      </section>
    );
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container">
        <div className="dl-label">IMMUTABLE SECURITY LEDGER</div>
        <h1 className="dl-section-title" style={{ marginBottom: '24px' }}>
          AUDIT LOG VIEWER
        </h1>

        {error && <StatusBanner kind="error" message={error} />}

        <Card>
          <form
            onSubmit={(e: React.FormEvent) => {
              e.preventDefault();
              setPage(1);
              void loadLogs();
            }}
          >
            <div className="dl-grid dl-grid-4">
              <Input label="ACTOR (USERNAME / ID)" value={actor} onChange={(e) => setActor(e.target.value)} />

              <div className="dl-field">
                <label htmlFor="aud-cat" className="dl-label">
                  CATEGORY
                </label>
                <select
                  id="aud-cat"
                  className="dl-input"
                  value={category}
                  onChange={(e) => {
                    setPage(1);
                    setCategory(e.target.value);
                  }}
                >
                  <option value="">ALL CATEGORIES</option>
                  {AuditCategories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <Input label="ACTION CONTAINS" value={action} onChange={(e) => setAction(e.target.value)} />
              <Input label="ENTITY TYPE" value={entityType} onChange={(e) => setEntityType(e.target.value)} />
            </div>

            <div className="dl-grid dl-grid-4" style={{ alignItems: 'end' }}>
              <Input label="ENTITY ID" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
              <Input
                label="START DATE"
                type="datetime-local"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
              <Input
                label="END DATE"
                type="datetime-local"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                <Button type="submit" variant="gold" style={{ flex: 1 }}>
                  APPLY
                </Button>
                <Button type="button" variant="ghost" onClick={handleResetFilters}>
                  RESET
                </Button>
              </div>
            </div>
          </form>
        </Card>

        <div style={{ marginTop: '24px' }}>
          {loading ? (
            <div className="dl-label">QUERYING AUDIT LEDGER...</div>
          ) : logs.length === 0 ? (
            <EmptyState
              title="NO AUDIT RECORDS MATCH FILTERS"
              description="Adjust your actor, category, entity, or date range filters."
            />
          ) : (
            <Card>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--text-ash)' }}>
                      <th className="dl-label" style={{ padding: '10px 8px' }}>TIMESTAMP</th>
                      <th className="dl-label" style={{ padding: '10px 8px' }}>CATEGORY</th>
                      <th className="dl-label" style={{ padding: '10px 8px' }}>ACTION</th>
                      <th className="dl-label" style={{ padding: '10px 8px' }}>ACTOR</th>
                      <th className="dl-label" style={{ padding: '10px 8px' }}>ENTITY</th>
                      <th className="dl-label" style={{ padding: '10px 8px' }}>DETAIL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((row) => (
                      <tr key={row.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                        <td style={{ padding: '12px 8px', fontSize: '13px', color: 'var(--text-ash)' }}>
                          {new Date(row.createdAt).toLocaleString()}
                        </td>
                        <td style={{ padding: '12px 8px' }}>
                          <span className="dl-badge">{row.category}</span>
                        </td>
                        <td style={{ padding: '12px 8px', color: 'var(--color-gold)' }}>{row.action}</td>
                        <td style={{ padding: '12px 8px' }}>
                          {row.actor ? `@${row.actor.username}` : 'SYSTEM'}
                          {row.actorRole && <div className="dl-label">{row.actorRole}</div>}
                        </td>
                        <td style={{ padding: '12px 8px', fontSize: '13px' }}>
                          {row.entityType}
                          {row.entityId ? ` (${row.entityId.slice(0, 12)}...)` : ''}
                        </td>
                        <td style={{ padding: '12px 8px' }}>
                          <Button type="button" variant="ghost" onClick={() => setSelected(row)}>
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

        {/* Selected Audit Record Detail Panel */}
        {selected && (
          <div style={{ marginTop: '24px' }}>
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div>
                  <div className="dl-label">AUDIT EVENT ID: {selected.id}</div>
                  <h2 className="dl-feature-title">{selected.action}</h2>
                </div>
                <Button type="button" variant="ghost" onClick={() => setSelected(null)}>
                  CLOSE
                </Button>
              </div>

              <div className="dl-label" style={{ marginBottom: '16px' }}>
                ENTITY: {selected.entityType} ({selected.entityId ?? 'N/A'}) · CORRELATION:{' '}
                {selected.correlationId ?? 'N/A'} · IP: {selected.ipAddress ?? 'REDACTED'}
              </div>

              <div className="dl-grid dl-grid-2">
                <div>
                  <div className="dl-label" style={{ marginBottom: '6px' }}>
                    PREVIOUS VALUES (REDACTED)
                  </div>
                  <pre style={{ margin: 0, padding: '12px', background: 'var(--color-black)', border: '1px solid var(--border-hairline)', overflowX: 'auto', fontSize: '12px' }}>
                    {JSON.stringify(selected.previousValues ?? {}, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="dl-label" style={{ marginBottom: '6px' }}>
                    NEW VALUES (REDACTED)
                  </div>
                  <pre style={{ margin: 0, padding: '12px', background: 'var(--color-black)', border: '1px solid var(--border-hairline)', overflowX: 'auto', fontSize: '12px' }}>
                    {JSON.stringify(selected.newValues ?? {}, null, 2)}
                  </pre>
                </div>
              </div>

              {selected.metadata && (
                <div style={{ marginTop: '16px' }}>
                  <div className="dl-label" style={{ marginBottom: '6px' }}>
                    METADATA (REDACTED)
                  </div>
                  <pre style={{ margin: 0, padding: '12px', background: 'var(--color-black)', border: '1px solid var(--border-hairline)', overflowX: 'auto', fontSize: '12px' }}>
                    {JSON.stringify(selected.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </section>
  );
}

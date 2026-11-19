import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBanner } from '../components/ui/StatusBanner';
import { ApiClientError, apiFetch } from '../lib/api';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  linkUrl: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ notifications: NotificationItem[]; unreadCount: number }>(
        `/api/v1/notifications?unreadOnly=${unreadOnly ? 'true' : 'false'}`,
      );
      setNotifications(res.notifications);
      setUnreadCount(res.unreadCount);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to load notifications');
    } finally {
      setLoading(false);
    }
  }, [unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleMarkRead(id: string) {
    setBusy(true);
    try {
      await apiFetch(`/api/v1/notifications/${id}/read`, { method: 'PATCH' });
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to update notification');
    } finally {
      setBusy(false);
    }
  }

  async function handleMarkAllRead() {
    setBusy(true);
    try {
      await apiFetch('/api/v1/notifications/read-all', { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to mark all as read');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dl-section" style={{ borderBottom: 'none' }}>
      <div className="dl-container" style={{ maxWidth: '880px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
            gap: '16px',
            marginBottom: '24px',
          }}
        >
          <div>
            <div className="dl-label">OPERATOR INBOX · {unreadCount} UNREAD</div>
            <h1 className="dl-section-title">NOTIFICATIONS</h1>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <Button
              type="button"
              variant={!unreadOnly ? 'gold' : 'ghost'}
              onClick={() => setUnreadOnly(false)}
            >
              ALL
            </Button>
            <Button
              type="button"
              variant={unreadOnly ? 'gold' : 'ghost'}
              onClick={() => setUnreadOnly(true)}
            >
              UNREAD ({unreadCount})
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy || unreadCount === 0}
              onClick={() => void handleMarkAllRead()}
            >
              MARK ALL READ
            </Button>
          </div>
        </div>

        {error && <StatusBanner kind="error" message={error} />}

        {loading ? (
          <div className="dl-label">LOADING NOTIFICATIONS...</div>
        ) : notifications.length === 0 ? (
          <EmptyState
            title="NO NOTIFICATIONS"
            description="Registration confirmations, competition start/end alerts, and organizer announcements appear here."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {notifications.map((n) => (
              <Card key={n.id}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: '16px',
                    flexWrap: 'wrap',
                    borderLeft: !n.isRead ? '3px solid var(--color-gold)' : '3px solid transparent',
                    paddingLeft: '12px',
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
                      <span className={`dl-badge ${!n.isRead ? 'dl-badge-gold' : ''}`}>{n.type}</span>
                      <span className="dl-label">{new Date(n.createdAt).toLocaleString()}</span>
                    </div>
                    <h2 className="dl-feature-title" style={{ fontSize: '20px', marginBottom: '6px' }}>
                      {n.title}
                    </h2>
                    <p style={{ color: 'var(--text-ash)', margin: 0 }}>{n.message}</p>
                    {n.linkUrl && (
                      <div style={{ marginTop: '10px' }}>
                        <Link to={n.linkUrl} style={{ color: 'var(--color-gold)', fontSize: '12px' }}>
                          OPEN LINK →
                        </Link>
                      </div>
                    )}
                  </div>

                  {!n.isRead && (
                    <Button type="button" variant="ghost" disabled={busy} onClick={() => void handleMarkRead(n.id)}>
                      MARK READ
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

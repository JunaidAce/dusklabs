import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../lib/api';
import './layout.css';

export function Navbar() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const loadUnreadCount = useCallback(async () => {
    if (!user) {
      setUnreadCount(0);
      return;
    }
    try {
      const res = await apiFetch<{ unreadCount: number }>('/api/v1/notifications?limit=1');
      setUnreadCount(res.unreadCount ?? 0);
    } catch {
      // Non-blocking (e.g. rate-limited or transient errors)
    }
  }, [user]);

  useEffect(() => {
    void loadUnreadCount();
  }, [loadUnreadCount]);

  useEffect(() => {
    function onFocus() {
      void loadUnreadCount();
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadUnreadCount]);

  async function handleLogout() {
    await logout();
    setDrawerOpen(false);
    navigate('/');
  }

  return (
    <>
      <header className="dl-nav">
        <div className="dl-nav-inner">
          <button
            type="button"
            className="dl-menu-btn"
            aria-label="Open navigation menu"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <svg width="20" height="14" viewBox="0 0 20 14" fill="none" aria-hidden="true">
              <line x1="0" y1="1" x2="20" y2="1" stroke="currentColor" strokeWidth="1.5" />
              <line x1="0" y1="7" x2="20" y2="7" stroke="currentColor" strokeWidth="1.5" />
              <line x1="0" y1="13" x2="20" y2="13" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <span>MENU</span>
          </button>

          <Link to="/" className="dl-brand" aria-label="DuskLabs Home">
            <span>
              DUSK<span className="dl-brand-accent">LABS</span>
            </span>
          </Link>

          <nav className="dl-nav-actions" aria-label="Primary actions">
            <NavLink to="/challenges">CHALLENGES</NavLink>
            <NavLink to="/leaderboard">SCOREBOARD</NavLink>
            {user ? (
              <>
                <NavLink to="/dashboard" className="dl-hide-mobile">DASHBOARD</NavLink>
                <NavLink to="/notifications" className="dl-hide-mobile" aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}>
                  ALERTS
                  {unreadCount > 0 && (
                    <span className="dl-badge dl-badge-gold" style={{ marginLeft: '6px', fontSize: '10px', padding: '1px 6px' }}>
                      {unreadCount}
                    </span>
                  )}
                </NavLink>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-ash)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 'inherit',
                    letterSpacing: 'inherit',
                    textTransform: 'uppercase',
                  }}
                >
                  LOGOUT
                </button>
              </>
            ) : (
              <>
                <Link to="/login">LOGIN</Link>
                <Link to="/register" style={{ color: 'var(--color-gold)' }}>
                  REGISTER
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      {drawerOpen && (
        <div
          className="dl-drawer-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Primary Navigation"
          onClick={() => setDrawerOpen(false)}
        >
          <div className="dl-drawer" onClick={(e) => e.stopPropagation()}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="dl-label">NAVIGATION</span>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close navigation menu"
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--border-ghost)',
                    color: 'var(--color-white)',
                    padding: '6px 12px',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                  }}
                >
                  CLOSE
                </button>
              </div>

              <div className="dl-drawer-links">
                <Link to="/" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                  HOME
                </Link>
                <Link to="/competitions" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                  COMPETITIONS
                </Link>
                <Link to="/teams" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                  TEAMS
                </Link>
                <Link to="/challenges" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                  CHALLENGES
                </Link>
                <Link to="/leaderboard" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                  SCOREBOARD
                </Link>
                <Link to="/achievements" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                  ACHIEVEMENTS
                </Link>
                {user ? (
                  <>
                    <Link to="/dashboard" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                      DASHBOARD
                    </Link>
                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      className="dl-drawer-link"
                      style={{
                        background: 'transparent',
                        borderTop: 'none',
                        borderLeft: 'none',
                        borderRight: 'none',
                        color: 'var(--color-gold)',
                        textAlign: 'left',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      LOGOUT ({user.username})
                    </button>
                    <Link to="/notifications" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                      NOTIFICATIONS{unreadCount > 0 ? ` (${unreadCount})` : ''}
                    </Link>
                  </>
                ) : (
                  <>
                    <Link to="/login" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                      LOGIN
                    </Link>
                    <Link
                      to="/register"
                      className="dl-drawer-link"
                      style={{ color: 'var(--color-gold)' }}
                      onClick={() => setDrawerOpen(false)}
                    >
                      REGISTER
                    </Link>
                    <Link to="/verify-email" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                      VERIFY EMAIL
                    </Link>
                  </>
                )}
                <Link to="/admin" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                  ADMIN OVERVIEW
                </Link>
                {user?.permissions.includes('challenge:create') && (
                  <Link to="/admin/challenges" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                    MANAGE CHALLENGES
                  </Link>
                )}
                {user?.permissions.includes('user:manage') && (
                  <Link to="/admin/users" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                    USER MANAGEMENT
                  </Link>
                )}
                {user?.permissions.includes('audit:logs:read') && (
                  <Link to="/admin/audit-logs" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                    AUDIT LOGS
                  </Link>
                )}
                {user?.permissions.includes('analytics:export') && (
                  <Link to="/admin/analytics" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                    ANALYTICS
                  </Link>
                )}
                {user?.permissions.includes('platform:settings:manage') && (
                  <Link to="/admin/settings" className="dl-drawer-link" onClick={() => setDrawerOpen(false)}>
                    PLATFORM SETTINGS
                  </Link>
                )}
              </div>
            </div>

            <div className="dl-label">WHERE CURIOSITY MEETS EXPLOITATION</div>
          </div>
        </div>
      )}
    </>
  );
}

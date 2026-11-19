import { Link } from 'react-router-dom';
import './layout.css';

export function Footer() {
  return (
    <footer className="dl-footer">
      <div className="dl-container">
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '24px',
            paddingBottom: '24px',
            borderBottom: '1px solid var(--border-hairline)',
          }}
        >
          <div>
            <div style={{ letterSpacing: '2px', textTransform: 'uppercase' }}>DUSKLABS</div>
            <div className="dl-label">WHERE CURIOSITY MEETS EXPLOITATION</div>
          </div>

          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', fontSize: '12px', letterSpacing: '0.96px' }}>
            <Link to="/">HOME</Link>
            <Link to="/competitions">COMPETITIONS</Link>
            <Link to="/leaderboard">LEADERBOARD</Link>
            <Link to="/login">LOGIN</Link>
            <Link to="/register">REGISTER</Link>
            <Link to="/verify-email">VERIFY EMAIL</Link>
            <Link to="/forgot-password">PASSWORD RECOVERY</Link>
          </div>
        </div>


      </div>
    </footer>
  );
}

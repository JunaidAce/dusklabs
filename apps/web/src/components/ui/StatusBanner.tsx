import './ui.css';

export function StatusBanner({
  kind,
  message,
}: {
  kind: 'error' | 'success' | 'info';
  message: string;
}) {
  const prefix = kind === 'error' ? '[ERROR]' : kind === 'success' ? '[CONFIRMED]' : '[NOTICE]';
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={`dl-banner ${kind === 'success' || kind === 'error' ? 'dl-banner-gold' : ''}`.trim()}
    >
      <strong style={{ color: 'var(--color-gold)', marginRight: '8px', letterSpacing: '0.96px' }}>
        {prefix}
      </strong>
      <span>{message}</span>
    </div>
  );
}

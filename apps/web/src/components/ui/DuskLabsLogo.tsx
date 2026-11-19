import React from 'react';
import './DuskLabsLogo.css';

export function DuskLabsMark({ size = 56, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      className={`dl-logo-mark ${className}`.trim()}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="dl-logo-metal" x1="14" y1="10" x2="82" y2="94" gradientUnits="userSpaceOnUse">
          <stop stopColor="#35353d" />
          <stop offset="1" stopColor="#08080b" />
        </linearGradient>
        <linearGradient id="dl-logo-red" x1="46" y1="8" x2="112" y2="102" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ff334f" />
          <stop offset="1" stopColor="#8c0f1d" />
        </linearGradient>
        <filter id="dl-logo-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>

      <path d="M22 18L58 4L58 78L22 96V18Z" fill="url(#dl-logo-metal)" stroke="#ff2d45" strokeWidth="2" />
      <path d="M58 4L80 18L80 58L58 76V4Z" fill="url(#dl-logo-red)" />
      <path d="M36 32L58 24V50L36 58V32Z" fill="#08080b" />

      <path d="M64 78L104 60V80L84 92L64 100V78Z" fill="url(#dl-logo-red)" />
      <path d="M64 78L84 68V80L64 90V78Z" fill="#08080b" />

      <path d="M22 18L58 4" stroke="#ff2d45" strokeWidth="2" filter="url(#dl-logo-glow)" opacity="0.8" />
      <path d="M64 78L104 60" stroke="#ff2d45" strokeWidth="2" filter="url(#dl-logo-glow)" opacity="0.8" />
    </svg>
  );
}

export function DuskLabsLogo({
  size = 28,
  stacked = false,
  className = '',
}: {
  size?: number;
  stacked?: boolean;
  className?: string;
}) {
  return (
    <span className={`dl-logo ${stacked ? 'dl-logo-stacked' : 'dl-logo-inline'} ${className}`.trim()}>
      <DuskLabsMark size={size} />
      <span className="dl-logo-wordmark" aria-label="DuskLabs">
        <span className="dl-wordmark-dusk">Dusk</span>
        <span className="dl-wordmark-labs">Labs</span>
      </span>
    </span>
  );
}

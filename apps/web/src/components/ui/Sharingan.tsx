import React from 'react';
import './Sharingan.css';

const TOMOE_ANGLES = [0, 120, 240];

function buildTomoePath(): string {
  const cx = 100;
  const cy = 100;
  const startDeg = -90;
  const sweepDeg = 138;
  const steps = 36;
  const outer: Array<[number, number]> = [];
  const inner: Array<[number, number]> = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = ((startDeg + sweepDeg * t) * Math.PI) / 180;
    const rOuter = 78 - 24 * t;
    const thickness = 21 * Math.pow(1 - t, 1.5) + 2.2;
    const rInner = rOuter - thickness;
    outer.push([cx + rOuter * Math.cos(angle), cy + rOuter * Math.sin(angle)]);
    inner.push([cx + rInner * Math.cos(angle), cy + rInner * Math.sin(angle)]);
  }

  const headAngle = (startDeg * Math.PI) / 180;
  const headRadius = 72;
  const headX = cx + headRadius * Math.cos(headAngle);
  const headY = cy + headRadius * Math.sin(headAngle);

  const fmt = (n: number) => n.toFixed(2);
  return [
    `M ${fmt(headX)} ${fmt(headY)}`,
    ...outer.map(([x, y]) => `L ${fmt(x)} ${fmt(y)}`),
    ...inner.reverse().map(([x, y]) => `L ${fmt(x)} ${fmt(y)}`),
    'Z',
  ].join(' ');
}

const TOMOE_PATH = buildTomoePath();

export function Sharingan({
  size,
  className = '',
  style,
}: {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`dl-sharingan ${className}`.trim()}
      style={{ ...(size ? { width: size, height: size } : null), ...style }}
      aria-hidden="true"
    >
      <span className="dl-sharingan-halo" />
      <span className="dl-sharingan-track">
        <span className="dl-sharingan-spin">
          <svg className="dl-sharingan-svg" viewBox="0 0 200 200" role="presentation">
            <circle cx="100" cy="100" r="88" fill="none" stroke="rgba(0, 0, 0, 0.3)" strokeWidth="3" />
            <circle cx="100" cy="100" r="62" fill="none" stroke="rgba(0, 0, 0, 0.2)" strokeWidth="2" />
            <g fill="#140409">
              {TOMOE_ANGLES.map((deg) => (
                <g key={deg} transform={`rotate(${deg} 100 100)`}>
                  <path d={TOMOE_PATH} />
                  <circle cx="100" cy="28" r="11.5" />
                </g>
              ))}
              <circle cx="100" cy="100" r="12" />
            </g>
          </svg>
        </span>
      </span>
      <span className="dl-sharingan-highlight" />
    </div>
  );
}

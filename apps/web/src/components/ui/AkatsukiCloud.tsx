import React from 'react';

export function AkatsukiCloud({
  size = 120,
  className = '',
  style,
  color = 'var(--color-cloud)',
  outline = 'var(--color-white)',
  strokeWidth = 4,
}: {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  color?: string;
  outline?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={(size * 150) / 240}
      viewBox="0 0 240 150"
      fill="none"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path
        d="M45 124C22 124 6 107 6 85C6 64 22 48 43 49C47 29 64 13 86 13C108 13 126 26 134 45C142 31 157 23 174 23C197 23 216 40 216 62C216 65 216 67 215 69C229 74 238 85 238 99C238 115 225 127 209 127L45 124Z"
        fill={color}
        stroke={outline}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <path
        d="M58 99C73 92 88 91 103 94M140 67C153 62 166 62 178 66"
        stroke="rgba(8, 7, 11, 0.24)"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

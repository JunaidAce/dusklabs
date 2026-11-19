import React from 'react';
import './ui.css';

export function Card({
  children,
  className = '',
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`dl-card ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}

import React from 'react';
import { Link } from 'react-router-dom';
import './ui.css';

type Variant = 'gold' | 'ghost' | 'white';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({ variant = 'gold', className = '', children, ...props }: ButtonProps) {
  return (
    <button className={`dl-btn dl-btn-${variant} ${className}`.trim()} {...props}>
      {children}
    </button>
  );
}

export function LinkButton({
  to,
  variant = 'gold',
  className = '',
  children,
}: {
  to: string;
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link to={to} className={`dl-btn dl-btn-${variant} ${className}`.trim()}>
      {children}
    </Link>
  );
}

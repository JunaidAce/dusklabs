import React from 'react';
import './ui.css';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

export function Input({ label, id, error, ...props }: InputProps) {
  const inputId = id ?? label.toLowerCase().replace(/\s+/g, '-');
  return (
    <div className="dl-field">
      <label htmlFor={inputId} className="dl-label">
        {label}
      </label>
      <input id={inputId} className="dl-input" aria-invalid={Boolean(error)} {...props} />
      {error && (
        <span role="alert" className="dl-field-error">
          {error}
        </span>
      )}
    </div>
  );
}

import React from 'react';
import { Card } from './Card';

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <Card>
      <div className="dl-label" style={{ marginBottom: '8px' }}>
        NO RECORDS AVAILABLE
      </div>
      <h3 className="dl-feature-title" style={{ marginBottom: '8px' }}>
        {title}
      </h3>
      <p style={{ color: 'var(--text-ash)', margin: '0 0 20px 0' }}>{description}</p>
      {action}
    </Card>
  );
}

import React from 'react';

export function isSafeHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function renderInline(text: string): React.ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return tokens.map((tok, idx) => {
    if (tok.startsWith('`') && tok.endsWith('`') && tok.length >= 2) {
      return (
        <code
          key={idx}
          style={{
            background: 'var(--color-black)',
            border: '1px solid var(--border-hairline)',
            padding: '2px 6px',
            fontSize: '14px',
          }}
        >
          {tok.slice(1, -1)}
        </code>
      );
    }
    if (tok.startsWith('**') && tok.endsWith('**') && tok.length >= 4) {
      return <strong key={idx}>{tok.slice(2, -2)}</strong>;
    }
    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
    if (linkMatch) {
      const [, label, href] = linkMatch;
      if (href && isSafeHttpUrl(href)) {
        return (
          <a
            key={idx}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--color-gold)', textDecoration: 'underline' }}
          >
            {label}
          </a>
        );
      }
      return <span key={idx}>{label}</span>;
    }
    return <React.Fragment key={idx}>{tok}</React.Fragment>;
  });
}

export function SafeMarkdown({ content }: { content: string }) {
  const blocks = content.split(/(```[\s\S]*?```)/g);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {blocks.map((block, bIdx) => {
        if (block.startsWith('```') && block.endsWith('```')) {
          const inner = block.slice(3, -3).replace(/^[a-zA-Z0-9_-]+\n/, '');
          return (
            <pre
              key={bIdx}
              style={{
                margin: 0,
                padding: '16px',
                background: 'var(--color-black)',
                border: '1px solid var(--border-hairline)',
                overflowX: 'auto',
                fontSize: '14px',
              }}
            >
              <code>{inner}</code>
            </pre>
          );
        }

        const lines = block.split('\n').filter((l) => l.trim().length > 0);
        return lines.map((line, lIdx) => {
          const key = `${bIdx}-${lIdx}`;
          if (line.startsWith('### ')) {
            return (
              <h4 key={key} style={{ margin: '8px 0 0 0', textTransform: 'uppercase' }}>
                {renderInline(line.slice(4))}
              </h4>
            );
          }
          if (line.startsWith('## ')) {
            return (
              <h3 key={key} className="dl-feature-title" style={{ fontSize: '20px', marginTop: '8px' }}>
                {renderInline(line.slice(3))}
              </h3>
            );
          }
          if (line.startsWith('# ')) {
            return (
              <h2 key={key} className="dl-feature-title" style={{ marginTop: '8px' }}>
                {renderInline(line.slice(2))}
              </h2>
            );
          }
          if (line.startsWith('- ')) {
            return (
              <div key={key} style={{ paddingLeft: '16px' }}>
                · {renderInline(line.slice(2))}
              </div>
            );
          }
          return (
            <p key={key} style={{ margin: 0, color: 'var(--text-smoke)' }}>
              {renderInline(line)}
            </p>
          );
        });
      })}
    </div>
  );
}

export function HexMark({ size = 28, stroke = '#FFFFFF' }: { size?: number; stroke?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <polygon points="16,2 28,9 28,23 16,30 4,23 4,9" stroke={stroke} strokeWidth="1.5" />
      <polygon points="16,9 22,12.5 22,19.5 16,23 10,19.5 10,12.5" stroke="#FF7A18" strokeWidth="1.2" />
    </svg>
  );
}

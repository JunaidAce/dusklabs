import { describe, expect, it } from 'vitest';
import { isSafeHttpUrl } from './SafeMarkdown';

describe('SafeMarkdown URL XSS Guard', () => {
  it('allows only http and https protocols and blocks javascript/data/vbscript payloads', () => {
    expect(isSafeHttpUrl('https://dusklabs.example/docs')).toBe(true);
    expect(isSafeHttpUrl('http://localhost:5173/challenges')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('JAVASCRIPT:alert(document.cookie)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHttpUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
  });
});

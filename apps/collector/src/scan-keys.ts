import { createHmac } from 'node:crypto';

/**
 * Codes printed on the label/DANFE (tracking number, NF-e access key) can reveal buyer data
 * (an NF-e key opens the invoice at SEFAZ). They are never stored: only a keyed HMAC of each,
 * so a scanned code can be matched without keeping the code itself.
 */
export const normalizeCode = (value: string) => value.normalize('NFKC').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

export function scanKeyFor(code: string, secret: string): string {
  return createHmac('sha256', secret).update(`axios-factory-scan:v1:${normalizeCode(code)}`).digest('hex').slice(0, 32);
}

/** HMACs for the printable codes of one order; empty when scanning is not configured. */
export function scanKeysFor(values: unknown[], secret: string | undefined): string[] {
  if (!secret) return [];
  const keys = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const code = normalizeCode(String(value));
    if (code.length >= 8 && code.length <= 64) keys.add(scanKeyFor(code, secret));
  }
  return [...keys].sort();
}

/** Every plausible code inside what the scanner read: the whole text and each long alphanumeric run (QR codes may carry URLs). */
export function scannedCandidates(text: string): string[] {
  const out = new Set<string>();
  const whole = normalizeCode(text);
  if (whole.length >= 6 && whole.length <= 64) out.add(whole);
  for (const part of text.split(/[^0-9A-Za-z]+/)) { const c = normalizeCode(part); if (c.length >= 6 && c.length <= 64) out.add(c); }
  return [...out].slice(0, 20);
}

export function validScanSecret(secret: string | undefined): string | undefined {
  const s = secret?.trim();
  if (!s) return undefined;
  if (s.length < 24) throw new Error('SCAN_KEY_INVALID');
  return s;
}

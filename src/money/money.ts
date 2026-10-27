// Money as integer minor units plus an ISO 4217 code. No floats reach a verdict (invariant I1).
export interface Money { minor: number; currency: string }

// ISO 4217 currencies PayPal supports with no minor unit.
const ZERO_DECIMAL = new Set(["JPY", "HUF", "TWD"]);
const digits = (currency: string) => (ZERO_DECIMAL.has(currency) ? 0 : 2);

export function parseMoney(value: string | number, currency: string): Money {
  const cur = String(currency || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) throw new Error(`bad currency: ${JSON.stringify(currency)}`);
  const s = String(value).trim();
  const d = digits(cur);
  const re = d === 0 ? /^(\d+)$/ : /^(\d+)(?:\.(\d{1,2}))?$/;
  const m = s.match(re);
  if (!m) throw new Error(`bad amount for ${cur}: ${JSON.stringify(value)}`);
  const whole = Number(m[1]);
  const frac = d === 0 ? 0 : Number((m[2] || "").padEnd(2, "0"));
  return { minor: whole * 10 ** d + frac, currency: cur };
}

export const moneyEqual = (a: Money, b: Money) => a.minor === b.minor && a.currency === b.currency;

export function formatMoney(m: Money): string {
  const d = digits(m.currency);
  if (d === 0) return `${m.minor} ${m.currency}`;
  return `${Math.floor(m.minor / 100)}.${String(m.minor % 100).padStart(2, "0")} ${m.currency}`;
}

// Loads checkout-proof/.env, enforces sandbox, and scrubs credentials from anything that leaves the process.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = path.join(ROOT, "out");
const parsed = dotenv.config({ path: path.join(ROOT, ".env"), quiet: true }).parsed ?? {};

export function requireSandbox() {
  if (process.env.PAYPAL_ENVIRONMENT !== "sandbox") throw new Error("PAYPAL_ENVIRONMENT must be sandbox");
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) throw new Error("PayPal sandbox credentials missing from .env");
}

// Every value from .env that could identify the account, plus live tokens registered at runtime.
const secrets = new Set<string>();
for (const k of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_SANDBOX_BUYER_EMAIL", "PAYPAL_SANDBOX_BUYER_PASSWORD", "PAYPAL_SANDBOX_MERCHANT_EMAIL", "PAYPAL_WEBHOOK_ID"]) {
  const v = parsed[k] ?? process.env[k];
  if (v && v.length >= 6) secrets.add(v);
}
export const addSecret = (v?: string) => { if (v && v.length >= 6) secrets.add(v); };

export function scrub<T>(x: T): T {
  if (x === undefined || x === null) return x;
  let s = typeof x === "string" ? x : JSON.stringify(x);
  for (const v of secrets) s = s.split(v).join("***");
  s = s.replace(/(Bearer|Basic)\s+[A-Za-z0-9._\-=+/]{12,}/g, "$1 ***");
  s = s.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"***"');
  s = s.replace(/eyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]{4,}){0,2}/g, "<jwt>"); // client tokens, id tokens
  return (typeof x === "string" ? s : JSON.parse(s)) as T;
}

export const mkdirp = (p: string) => { fs.mkdirSync(p, { recursive: true }); return p; };

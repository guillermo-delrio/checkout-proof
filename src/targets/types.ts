import type { Money } from "../money/money.ts";
import type { ShopState } from "../money/verdict.ts";

export type Variant = "original" | "upgraded";
export interface ShopCall { step: string; http: number; body?: unknown }

// How the proof drives one target. The runner never touches the target's code; it only calls these.
export interface Adapter {
  target: string;
  variant: Variant;
  workDir: string;
  baseUrl: string;
  ppLogFile: string;
  appLogFile: string;
  // Scenario ids this variant can run; others are recorded as N/A with the reason.
  unsupported: Record<string, string>;
  prepare(opts?: { rebuild?: boolean }): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  newShopOrder(): Promise<{ id: string; total: Money }>;
  shopState(id: string): Promise<ShopState>;
  // Creates the PayPal order the way this shop does (server endpoint, or the browser's payload for client-side shops).
  checkout(shopOrderId: string): Promise<{ ppOrderId?: string; call: ShopCall }>;
  // The shop's "buyer approved, now take the money" step. Returns every call it made into the shop.
  // clientMock: for browser-side captures, the mock code the browser's capture call gets.
  // lose: the capture happens at PayPal but its response never reaches the code that confirms (SCENARIOS #9a).
  complete(ppOrderId: string, opts?: { clientMock?: string; lose?: boolean }): Promise<ShopCall[]>;
  // Hands a PayPal order made elsewhere (attacker, tampering client) to the shop's complete step.
  submitForeign(ppOrderId: string): Promise<ShopCall[]>;
  // Arms PayPal-Mock-Response for the next shop-server call whose path contains `match`.
  mock(match: string, code: string, method?: string): void;
  // Lets the shop server's next matching PayPal call go through, then drops PayPal's response.
  dropNext(match: string): void;
  mode: string;                       // "demo" | "production" for simple-clothing-store; "default" where a shop has one
  // Optional hooks for targets whose scenarios differ (expressCart):
  scenarios?: import("../prove/scenarios.ts").Scenario[];
  ensureUp?(): Promise<string | undefined>;
  // Restarts the shop's process only (a deploy or crash between two steps of one payment); its data folder stays.
  restart?(): Promise<void>;   // restarts a crashed shop; returns what happened, if anything
  screenshotOrder?(shopOrderId: string, file: string): Promise<void>;
  // Drives the shop's own PayPal button in a browser, if the variant has a server-side flow to drive.
  uiCheckout?(shopOrderId: string, shotDir: string): Promise<{ ppOrderId?: string; calls: ShopCall[]; notes: string[] }>;
  orderPageUrl(shopOrderId: string): string;
  // Labelled synthetic (SCENARIOS #10b): while on, PayPal's COMPLETED captures reach the shop's server as PENDING.
  rewritePending?(on: boolean): void;
  // Labelled synthetic: while set, PayPal's answers to the shop report this amount value and/or currency for the
  // order and its captures (the shop's own order; PayPal's real record is unchanged). null switches it off.
  rewriteMoney?(spec: { value?: string; currency?: string } | null): void;
}

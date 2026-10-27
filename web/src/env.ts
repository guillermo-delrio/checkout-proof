// Build flavours. The hosted site (Cloud Run) is the default. `VITE_CP_STATIC=1` builds the read-only fallback copy
// (scripts/build-static.sh): no live buttons or scan box, saved live runs from a snapshot, served under a base path
// such as /checkout-proof/ on GitHub Pages.
export const STATIC = import.meta.env.VITE_CP_STATIC === "1";
export const LIVE_URL: string = import.meta.env.VITE_CP_LIVE_URL || "https://checkout-proof-149219545146.us-central1.run.app";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, ""); // "" on the hosted site
/** An app path ("/proof/x#y") as a URL under the base path. */
export const withBase = (p: string) => BASE + p;
/** The app path of a pathname under the base path. */
export const stripBase = (p: string) => (BASE && p.startsWith(BASE) ? p.slice(BASE.length) || "/" : p);
/** A file in the built site ("data/shots/a.png"). */
export const asset = (p: string) => BASE + "/" + p.replace(/^\//, "");

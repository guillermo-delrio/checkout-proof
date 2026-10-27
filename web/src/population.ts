// Measured on 16 Oct 2026 (round3-challenge.md): npm downloads API, last week; Sourcegraph public index, forks and
// archived repos excluded. Floors: the index covers popular repos only.
export const POPULATION = {
  measuredOn: "16 Oct 2026",
  npm: [
    { pkg: "@paypal/checkout-server-sdk", perWeek: 61307, deprecated: true },
    { pkg: "paypal-rest-sdk", perWeek: 34561, deprecated: true },
    { pkg: "@paypal/paypal-server-sdk", perWeek: 149060, deprecated: false },
  ],
  repos: [
    { pattern: "JS SDK v5 script (paypal.com/sdk/js)", count: 222, note: "161 with 100+ stars; v6 available" },
    { pattern: "paypal.Buttons() (v5)", count: 164, note: "118 with 100+ stars" },
    { pattern: "paypal-rest-sdk in package.json", count: 35, note: "v1 Payments, deprecated" },
    { pattern: "@paypal/checkout-server-sdk in package.json", count: 13, note: "deprecated" },
    { pattern: "@paypal/paypal-server-sdk in package.json", count: 12, note: "already migrated" },
    { pattern: "JS SDK v6 script", count: 0, note: "almost nobody popular yet" },
  ],
};

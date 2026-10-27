// The harness, not the shop, failed (sandbox buyer page did not finish). The runner retries and never sends it to
// the model as the shop's fault: a fix round once chased a buyer timeout (17 Oct, plain arm, round 2).
export class HarnessError extends Error {
  readonly cause_: "harness" | "paypal" = "harness";
}
// PayPal's sandbox, not the shop and not our code: e.g. no webhook delivery reached our listener in the window
// (review r2, sceptic N2). Scored INCONCLUSIVE with cause "paypal", retried once.
export class PayPalSlowError extends HarnessError {
  override readonly cause_ = "paypal" as const;
}

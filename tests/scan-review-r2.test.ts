// Scanner fix from review r2 (reviews/r2-PLAN.md B2.6): a COMPLETED check on the order that only picks where to read
// the capture from is not "order-status-only" when the same file reads the capture and maps its status. The fixture
// is evershopcommerce/evershop@7509965 packages/evershop/src/modules/paypal/services/finalizePaypalOrder.ts, cut down.
import { describe, expect, it } from "vitest";
import { readsCaptureStatus } from "../src/scan/rules.ts";
import { scanSource } from "../src/scan/scan.ts";

const ids = (file: string, src: string) => scanSource(file, src).map((f) => f.rule).sort();

const EVERSHOP = `
export function mapCaptureStatus(status?: string): string | null {
  if (status === 'COMPLETED') {
    return 'paypal_captured';
  }
  if (status === 'PENDING') {
    return 'paypal_pending';
  }
  return null;
}
export async function finalizePaypalOrder(order: any, axiosInstance: AxiosInstance) {
  const { data: paypalOrder } = await axiosInstance.get(\`/v2/checkout/orders/\${order.integration_order_id}\`);
  const strategy = {
    action: 'capture',
    endpoint: \`/v2/checkout/orders/\${order.integration_order_id}/capture\`,
    alreadyDoneIssue: 'ORDER_ALREADY_CAPTURED',
    extract: (data) => data?.purchase_units?.[0]?.payments?.captures?.[0],
    map: mapCaptureStatus
  };
  let source;
  if (paypalOrder.status === 'COMPLETED') {
    source = paypalOrder;
  } else {
    const response = await axiosInstance.post(strategy.endpoint, {}, { headers: { 'PayPal-Request-Id': \`\${order.uuid}-capture\` } });
    source = response.data;
  }
  const payment = strategy.extract(source);
  const paymentStatus = strategy.map(payment.status);
  if (!paymentStatus) throw new PaypalPaymentDeclinedError('declined');
}
`;

describe("order-status-only on a file that maps the capture's status (evershop)", () => {
  it("evershop's finalizePaypalOrder gives no finding at all", () => {
    expect(ids("packages/evershop/src/modules/paypal/services/finalizePaypalOrder.ts", EVERSHOP)).toEqual([]);
  });
  it("the same order check without the capture read is still flagged", () => {
    const noCapture = `if (paypalOrder.status === 'COMPLETED') { markPaid(order) }\nif (x.status === 'PENDING') hold()`;
    expect(ids("svc.ts", noCapture)).toContain("order-status-only");
  });
  it("reading captures[0] without handling PENDING does not withdraw it", () => {
    const src = `if (order.status === 'COMPLETED') markPaid(order)\nconst id = order.purchase_units[0].payments.captures[0].id`;
    expect(readsCaptureStatus(src)).toBe(false);
    expect(ids("svc.ts", src)).toContain("order-status-only");
  });
  it("a switch over the capture's status counts as handling it", () => {
    expect(readsCaptureStatus(`const c = res.purchase_units[0].payments.captures[0];\nswitch (c.status) { case 'PENDING': hold(); }`)).toBe(true);
  });
});

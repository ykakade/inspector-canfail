// The same module, tested for real. Fakes only at the boundary: the card
// processor and the mail server. Every expected value was worked out by hand.
import { describe, expect, it, vi } from "vitest";
import { checkout, discount, type Order, shipping, subtotal, tax, total } from "../../src/checkout";
import type { Mailer, PaymentGateway } from "../../src/services";

const fakeGateway = (result = { ok: true, id: "ch_1" }) =>
  ({ charge: vi.fn(async () => result) }) satisfies PaymentGateway;
const fakeMailer = () => ({ sendReceipt: vi.fn(async () => {}) }) satisfies Mailer;

// 3 tees at $10 = $30. US tax 8% = $2.40. Under $50, so $5 shipping. Total $37.40.
const order = (changes: Partial<Order> = {}): Order => ({
  items: [{ sku: "tee", price: 10, qty: 3 }],
  country: "US",
  email: "ada@example.com",
  ...changes,
});

describe("subtotal", () => {
  it("multiplies price by quantity and adds the lines", () => {
    expect(subtotal([{ sku: "tee", price: 10, qty: 3 }, { sku: "mug", price: 12, qty: 1 }])).toBe(42);
  });

  it("is 0 for no items", () => {
    expect(subtotal([])).toBe(0);
  });
});

describe("discount", () => {
  it("takes 10% off with SAVE10", () => {
    expect(discount(30, "SAVE10")).toBe(3);
  });

  it("takes half off with HALF at exactly $100", () => {
    expect(discount(100, "HALF")).toBe(50);
  });

  it("ignores HALF under $100", () => {
    expect(discount(99, "HALF")).toBe(0);
  });

  it("gives nothing without a coupon, even on a big order", () => {
    expect(discount(200)).toBe(0);
  });
});

describe("shipping", () => {
  it("costs $5 just under the threshold", () => {
    expect(shipping(49.99)).toBe(5);
  });

  it("is free at exactly $50", () => {
    expect(shipping(50)).toBe(0);
  });
});

describe("tax", () => {
  it.each([
    ["US", 8],
    ["DE", 19],
    ["GB", 20],
    ["XX", 0],
  ])("charges the %s rate on $100", (country, expected) => {
    expect(tax(100, country)).toBe(expected);
  });

  it("rounds to whole cents", () => {
    expect(tax(19.99, "DE")).toBe(3.8); // 19.99 * 0.19 = 3.7981
  });
});

describe("total", () => {
  it("adds shipping and tax to the subtotal", () => {
    expect(total(order())).toBe(37.4);
  });

  it("applies the coupon before shipping and tax", () => {
    // $30 - $3 = $27. Tax 8% = $2.16. Shipping $5. Total $34.16.
    expect(total(order({ coupon: "SAVE10" }))).toBeCloseTo(34.16, 10);
  });

  it("refuses an empty cart", () => {
    expect(() => total(order({ items: [] }))).toThrow("Cart is empty");
  });
});

describe("checkout", () => {
  it("charges the total in cents and in USD", async () => {
    const gateway = fakeGateway();
    await checkout(order(), gateway, fakeMailer());
    expect(gateway.charge).toHaveBeenCalledExactlyOnceWith(3740, "usd");
  });

  it("returns a paid receipt and emails it", async () => {
    const mailer = fakeMailer();
    const receipt = await checkout(order(), fakeGateway(), mailer);
    expect(receipt).toEqual({ status: "paid", total: 37.4, chargeId: "ch_1" });
    expect(mailer.sendReceipt).toHaveBeenCalledExactlyOnceWith("ada@example.com", receipt);
  });

  it("fails when the receipt email fails, so a failure is never hidden", async () => {
    const mailer = { sendReceipt: vi.fn(async () => { throw new Error("mail server down"); }) } satisfies Mailer;
    await expect(checkout(order(), fakeGateway(), mailer)).rejects.toThrow("mail server down");
  });

  it("returns a declined receipt and sends no email when the card fails", async () => {
    const mailer = fakeMailer();
    const receipt = await checkout(order(), fakeGateway({ ok: false, id: "" }), mailer);
    expect(receipt).toEqual({ status: "declined", total: 37.4 });
    expect(mailer.sendReceipt).not.toHaveBeenCalled();
  });
});

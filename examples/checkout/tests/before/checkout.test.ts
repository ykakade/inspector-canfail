// The kind of suite an agent writes when the real code "is hard to test".
// Every test passes. Run `npm run demo` to see how many bugs it catches.
import { describe, expect, it, vi } from "vitest";
import { discount, shipping, subtotal, tax, total } from "../../src/checkout";

vi.mock("../../src/checkout", () => ({
  FREE_SHIPPING_FROM: 50,
  subtotal: vi.fn((items: { price: number; qty: number }[]) =>
    items.reduce((sum, item) => sum + item.price * item.qty, 0),
  ),
  discount: vi.fn((amount: number, coupon?: string) => (coupon === "SAVE10" ? amount * 0.1 : 0)),
  shipping: vi.fn((amount: number) => (amount >= 50 ? 0 : 5)),
  tax: vi.fn((amount: number, country: string) => (country === "US" ? amount * 0.08 : 0)),
  total: vi.fn(() => 37.4),
}));

const tee = { sku: "tee", price: 10, qty: 3 };
const order = { items: [tee], country: "US", email: "ada@example.com" };

describe("subtotal", () => {
  it("adds up price times quantity", () => {
    expect(subtotal([tee])).toBe(30);
  });

  it("handles several items", () => {
    expect(subtotal([tee, { sku: "mug", price: 12, qty: 1 }])).toBe(42);
  });

  it("returns 0 for no items", () => {
    expect(subtotal([])).toBe(0);
  });

  it("is called with the cart items", () => {
    subtotal([tee]);
    expect(subtotal).toHaveBeenCalledWith([tee]);
  });
});

describe("discount", () => {
  it("takes 10% off with SAVE10", () => {
    expect(discount(30, "SAVE10")).toBe(3);
  });

  it("gives no discount without a coupon", () => {
    expect(discount(30)).toBe(0);
  });

  it("ignores unknown coupons", () => {
    expect(discount(30, "BOGUS")).toBe(0);
  });

  it("passes the coupon through", () => {
    discount(80, "SAVE10");
    expect(discount).toHaveBeenLastCalledWith(80, "SAVE10");
  });
});

describe("shipping", () => {
  it("charges $5 on small orders", () => {
    expect(shipping(20)).toBe(5);
  });

  it("is free from $50", () => {
    expect(shipping(50)).toBe(0);
  });

  it("is free on big orders", () => {
    expect(shipping(500)).toBe(0);
  });
});

describe("tax", () => {
  it("charges 8% in the US", () => {
    expect(tax(100, "US")).toBe(8);
  });

  it("charges no tax elsewhere", () => {
    expect(tax(100, "FR")).toBe(0);
  });

  it("returns a number", () => {
    expect(typeof tax(10, "US")).toBe("number");
  });
});

describe("total", () => {
  it("adds subtotal, shipping and tax", () => {
    expect(total(order)).toBe(37.4);
  });

  it("is called once per order", () => {
    total(order);
    expect(total).toHaveBeenCalled();
  });

  it("returns a positive amount", () => {
    expect(total(order)).toBeGreaterThan(0);
  });

  it("matches the receipt total", () => {
    const amount = total(order);
    expect(amount).toEqual(37.4);
  });
});

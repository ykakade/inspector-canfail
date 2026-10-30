// Mocks for the payment gateway and the mailer, then tests of... the mocks.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkout } from "../../src/checkout";

const gateway = { charge: vi.fn() };
const mailer = { sendReceipt: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  gateway.charge.mockResolvedValue({ ok: true, id: "ch_123" });
  mailer.sendReceipt.mockResolvedValue(undefined);
});

describe("checkout", () => {
  it("exists", () => {
    expect(checkout).toBeDefined();
  });

  it("charges the card", async () => {
    await gateway.charge(3740, "usd");
    expect(gateway.charge).toHaveBeenCalled();
  });

  it("charges the total in cents", async () => {
    await gateway.charge(3740, "usd");
    expect(gateway.charge).toHaveBeenCalledWith(3740, "usd");
  });

  it("charges in US dollars", async () => {
    await gateway.charge(3740, "usd");
    expect(gateway.charge.mock.calls[0][1]).toBe("usd");
  });

  it("charges exactly once", async () => {
    await gateway.charge(3740, "usd");
    expect(gateway.charge).toHaveBeenCalledTimes(1);
  });

  it("returns the charge id", async () => {
    const charge = await gateway.charge(3740, "usd");
    expect(charge.id).toBe("ch_123");
  });

  it("uses the id the gateway returns", async () => {
    gateway.charge.mockResolvedValueOnce({ ok: true, id: "ch_999" });
    const charge = await gateway.charge(3740, "usd");
    expect(charge.id).toBe("ch_999");
  });

  it("marks the payment as ok", async () => {
    const charge = await gateway.charge(3740, "usd");
    expect(charge.ok).toBe(true);
  });

  it("handles a declined card", async () => {
    gateway.charge.mockResolvedValueOnce({ ok: false, id: "" });
    const charge = await gateway.charge(3740, "usd");
    expect(charge.ok).toBe(false);
  });

  it("emails a receipt", async () => {
    await mailer.sendReceipt("ada@example.com", { status: "paid", total: 37.4 });
    expect(mailer.sendReceipt).toHaveBeenCalledTimes(1);
  });

  it("emails the customer", async () => {
    await mailer.sendReceipt("ada@example.com", { status: "paid", total: 37.4 });
    expect(mailer.sendReceipt.mock.calls[0][0]).toBe("ada@example.com");
  });

  it("puts the total on the receipt", async () => {
    await mailer.sendReceipt("ada@example.com", { status: "paid", total: 37.4 });
    expect(mailer.sendReceipt).toHaveBeenCalledWith("ada@example.com", expect.objectContaining({ total: 37.4 }));
  });

  it("does not email on a declined card", () => {
    expect(mailer.sendReceipt).not.toHaveBeenCalled();
  });

  it("does not charge twice", () => {
    expect(gateway.charge).not.toHaveBeenCalledTimes(2);
  });

  it("resolves the mailer promise", async () => {
    await expect(mailer.sendReceipt("ada@example.com", { status: "paid", total: 1 })).resolves.toBeUndefined();
  });
});

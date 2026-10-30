import type { Mailer, PaymentGateway } from "./services";

export interface Item {
  sku: string;
  price: number;
  qty: number;
}

export interface Order {
  items: Item[];
  coupon?: string;
  country: string;
  email: string;
}

export interface Receipt {
  status: "paid" | "declined";
  total: number;
  chargeId?: string;
}

export const FREE_SHIPPING_FROM = 50;
const SHIPPING_FEE = 5;
const TAX_RATES: Record<string, number> = { US: 0.08, DE: 0.19, GB: 0.2 };

export function subtotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

export function discount(amount: number, coupon?: string): number {
  if (coupon === "SAVE10") return amount * 0.1;
  if (coupon === "HALF" && amount >= 100) return amount / 2;
  return 0;
}

export function shipping(amount: number): number {
  return amount >= FREE_SHIPPING_FROM ? 0 : SHIPPING_FEE;
}

export function tax(amount: number, country: string): number {
  return Math.round(amount * (TAX_RATES[country] ?? 0) * 100) / 100;
}

export function total(order: Order): number {
  if (order.items.length === 0) throw new Error("Cart is empty");
  const sub = subtotal(order.items);
  const net = sub - discount(sub, order.coupon);
  return net + shipping(net) + tax(net, order.country);
}

export async function checkout(order: Order, gateway: PaymentGateway, mailer: Mailer): Promise<Receipt> {
  const amount = total(order);
  const charge = await gateway.charge(Math.round(amount * 100), "usd");
  if (!charge.ok) return { status: "declined", total: amount };
  const receipt: Receipt = { status: "paid", total: amount, chargeId: charge.id };
  await mailer.sendReceipt(order.email, receipt);
  return receipt;
}

import type { Receipt } from "./checkout";

/** Talks to the card processor. Real calls cost money, so tests use a fake. */
export interface PaymentGateway {
  charge(cents: number, currency: string): Promise<{ ok: boolean; id: string }>;
}

/** Sends email. Tests use a fake. */
export interface Mailer {
  sendReceipt(email: string, receipt: Receipt): Promise<void>;
}

const t = {};
t.pricing = { file: "pricing", src: `export interface Item { price: number; qty: number; digital?: boolean }
export interface Options { coupon?: string; taxExempt?: boolean }
export function orderTotal(items: Item[], opts: Options = {}): number {
  let subtotal = 0;
  for (const item of items) {
    if (!Number.isInteger(item.qty) || item.qty <= 0) throw new RangeError("qty must be a positive integer");
    subtotal += item.price * item.qty;
  }
  let rate = 0;
  if (subtotal >= 500) rate = 0.2;
  else if (subtotal >= 100) rate = 0.1;
  let discounted = subtotal * (1 - rate);
  if (opts.coupon === "SAVE5") discounted = Math.max(0, discounted - 5);
  const tax = opts.taxExempt ? 0 : discounted * 0.08;
  const physical = items.some((i) => !i.digital);
  const shipping = physical && discounted < 50 ? 5 : 0;
  return Math.round((discounted + tax + shipping) * 100) / 100;
}
`, req: `# Order totals
- Subtotal is price x qty summed. qty must be a positive integer, otherwise throw RangeError.
- Subtotal of 100 or more gets 10% off. Subtotal of 500 or more gets 20% off instead.
- Coupon SAVE5 takes 5 off after the percentage discount. The amount cannot go below 0.
- Tax is 8% of the amount after discounts. Tax-exempt orders pay no tax.
- Shipping is 5, free when the amount after discounts is 50 or more. Orders with only digital items pay no shipping.
- The result is rounded to 2 decimals.
`, oracle: `import { it, expect } from "vitest"; import { orderTotal as o } from "../src/pricing";
const p=(price:number,extra={})=>[{price,qty:1,...extra}];
it("a",()=>{expect(o(p(100))).toBe(97.2);expect(o(p(99.99,{}))).toBe(107.99);expect(o(p(500))).toBe(432);expect(o(p(499))).toBe(485.03)});
it("b",()=>{expect(o(p(200),{coupon:"SAVE5"})).toBe(189)});
it("c",()=>{expect(o(p(3,{digital:true}),{coupon:"SAVE5"})).toBe(0)});
it("d",()=>{expect(o(p(200),{taxExempt:true})).toBe(180)});
it("e",()=>{expect(o(p(50))).toBe(54);expect(o(p(49))).toBe(57.92);expect(o(p(10,{digital:true}))).toBe(10.8);expect(o([{price:10,qty:1,digital:true},{price:10,qty:1}])).toBe(26.6)});
it("f",()=>{expect(o(p(54),{coupon:"SAVE5"})).toBe(57.92)});
it("g",()=>{expect(()=>o([{price:1,qty:0}])).toThrow(RangeError);expect(()=>o([{price:1,qty:1.5}])).toThrow(RangeError)});
it("h",()=>{expect(o(p(1.111,{digital:true}))).toBe(1.2);expect(o([{price:30,qty:2}])).toBe(64.8)});
`, bugs: [
 ["boundary 100", "subtotal >= 100", "subtotal > 100"], ["boundary 500", "subtotal >= 500", "subtotal > 500"],
 ["coupon floor removed", "Math.max(0, discounted - 5)", "discounted - 5"],
 ["tax on undiscounted", "discounted * 0.08", "subtotal * 0.08"],
 ["exempt ignored", "opts.taxExempt ? 0 : discounted * 0.08", "discounted * 0.08"],
 ["shipping uses subtotal", "discounted < 50", "subtotal < 50"], ["shipping boundary", "discounted < 50", "discounted <= 50"],
 ["any digital item waives shipping", "items.some((i) => !i.digital)", "items.every((i) => !i.digital)"],
 ["qty zero allowed", "item.qty <= 0", "item.qty < 0"], ["fractional qty allowed", "!Number.isInteger(item.qty) || ", ""],
 ["no rounding", "Math.round((discounted + tax + shipping) * 100) / 100", "discounted + tax + shipping"],
 ["qty ignored", "item.price * item.qty", "item.price"],
]};
t.ratelimit = { file: "ratelimit", src: `export interface Clock { now(): number }
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private capacity: number, private refillPerSec: number, private clock: Clock) {
    if (capacity <= 0) throw new RangeError("capacity must be positive");
    if (refillPerSec < 0) throw new RangeError("refill must not be negative");
    this.tokens = capacity;
    this.last = clock.now();
  }
  private refill() {
    const now = this.clock.now();
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.last = now;
  }
  tryTake(n = 1): boolean {
    if (n <= 0) throw new RangeError("n must be positive");
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
  retryAfterMs(n = 1): number {
    if (n > this.capacity) return Infinity;
    this.refill();
    if (this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) / this.refillPerSec) * 1000);
  }
}
`, req: `# Token bucket
- The bucket starts full. Capacity must be positive and refill must not be negative, otherwise throw RangeError.
- Tokens refill continuously at refillPerSec, up to capacity. Time comes from the injected clock (milliseconds).
- If the clock moves backwards, no tokens are lost.
- tryTake(n) takes n tokens and returns true if at least n are available. Otherwise it takes nothing and returns false. n <= 0 throws RangeError.
- available() returns the number of whole tokens.
- retryAfterMs(n) returns 0 if n tokens are available now, otherwise the milliseconds until they are, rounded up. It returns Infinity if n is more than capacity.
`, oracle: `import { it, expect } from "vitest"; import { TokenBucket as T } from "../src/ratelimit";
const clk=(t=1000)=>({t,now(){return this.t}});
it("a",()=>{const c=clk();const b=new T(3,1,c);expect(b.tryTake(3)).toBe(true);expect(b.tryTake()).toBe(false);c.t+=1000;expect(b.tryTake()).toBe(true);expect(b.tryTake()).toBe(false)});
it("b",()=>{const c=clk();const b=new T(2,1,c);c.t+=10000;expect(b.available()).toBe(2)});
it("c",()=>{const c=clk();const b=new T(5,1,c);b.tryTake(2);c.t-=5000;expect(b.available()).toBe(3)});
it("d",()=>{const c=clk();const b=new T(5,0,c);expect(b.tryTake(6)).toBe(false);expect(b.available()).toBe(5)});
it("e",()=>{const c=clk();const b=new T(2,1,c);b.tryTake(2);c.t+=1500;expect(b.available()).toBe(1)});
it("f",()=>{const c=clk();const b=new T(2,3,c);b.tryTake(2);expect(b.retryAfterMs(1)).toBe(334);expect(b.retryAfterMs(3)).toBe(Infinity);c.t+=1000;expect(b.retryAfterMs(1)).toBe(0)});
it("g",()=>{const c=clk();expect(()=>new T(0,1,c)).toThrow(RangeError);expect(()=>new T(1,-1,c)).toThrow(RangeError);expect(()=>new T(1,1,c).tryTake(0)).toThrow(RangeError);expect(new T(1,0,c).tryTake()).toBe(true)});
`, bugs: [
 ["take boundary", "this.tokens >= n) {", "this.tokens > n) {"], ["no cap", "Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec)", "this.tokens + elapsed * this.refillPerSec"],
 ["backward clock loses tokens", "Math.max(0, now - this.last) / 1000", "(now - this.last) / 1000"], ["seconds not ms", "now - this.last) / 1000", "now - this.last)"],
 ["failed take consumes", "    return false;\n  }\n  available", "    this.tokens = Math.max(0, this.tokens - n);\n    return false;\n  }\n  available"],
 ["starts empty", "this.tokens = capacity;", "this.tokens = 0;"], ["available rounds up", "Math.floor(this.tokens)", "Math.ceil(this.tokens)"],
 ["retry rounds down", "Math.ceil(((n", "Math.floor(((n"], ["retry never infinity", "    if (n > this.capacity) return Infinity;\n", ""],
 ["capacity zero allowed", "capacity <= 0", "capacity < 0"], ["negative refill allowed", "    if (refillPerSec < 0) throw new RangeError(\"refill must not be negative\");\n", ""],
 ["take zero allowed", "    if (n <= 0) throw new RangeError(\"n must be positive\");\n", ""],
]};
t.payment = { file: "payment", src: `export interface Gateway { charge(req: { amountCents: number; idempotencyKey: string }): Promise<{ id: string }> }
export class GatewayError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}
export interface RetryOptions { maxAttempts?: number; baseDelayMs?: number; sleep: (ms: number) => Promise<void> }
export async function chargeWithRetry(gateway: Gateway, amountCents: number, key: string, opts: RetryOptions) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new RangeError("amount must be a positive integer");
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 100;
  for (let attempt = 1; ; attempt++) {
    try {
      const { id } = await gateway.charge({ amountCents, idempotencyKey: key });
      return { id, attempts: attempt };
    } catch (error) {
      if (!(error instanceof GatewayError) || !error.retryable) throw error;
      if (attempt >= maxAttempts) throw error;
      await opts.sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}
`, req: `# Charge with retry
- amountCents must be a positive integer, otherwise throw RangeError and do not call the gateway.
- Every attempt for one call uses the same amount and the same idempotency key, so a customer is never charged twice.
- Only a GatewayError with retryable=true is retried. Any other error is rethrown at once, unchanged.
- At most maxAttempts attempts (default 3). When attempts run out, the last error is rethrown unchanged.
- The wait before retry k is baseDelayMs x 2^(k-1), default base 100: 100, 200, 400. There is no wait after the last attempt.
- On success, return the gateway id and the number of attempts made.
`, oracle: `import { it, expect } from "vitest"; import { chargeWithRetry as c, GatewayError as G } from "../src/payment";
const setup=(...rs:any[])=>{const calls:any[]=[];const waits:number[]=[];return{calls,waits,gw:{charge:async(r:any)=>{calls.push(r);const x=rs.shift();if(x instanceof Error)throw x;return{id:x}}},sleep:async(m:number)=>{waits.push(m)}}};
const R=()=>new G("r",true);
it("a",async()=>{const s=setup(R(),R(),"ok");expect(await c(s.gw,5,"k",{sleep:s.sleep})).toEqual({id:"ok",attempts:3});expect(s.calls).toEqual([{amountCents:5,idempotencyKey:"k"},{amountCents:5,idempotencyKey:"k"},{amountCents:5,idempotencyKey:"k"}]);expect(s.waits).toEqual([100,200])});
it("b",async()=>{const e=new G("n",false);const s=setup(e,"ok");await expect(c(s.gw,5,"k",{sleep:s.sleep})).rejects.toBe(e);expect(s.calls.length).toBe(1)});
it("c",async()=>{const e=new TypeError("t");const s=setup(e,"ok");await expect(c(s.gw,5,"k",{sleep:s.sleep})).rejects.toBe(e);expect(s.calls.length).toBe(1)});
it("d",async()=>{const l=R();const s=setup(R(),R(),l,"ok");await expect(c(s.gw,5,"k",{sleep:s.sleep})).rejects.toBe(l);expect(s.calls.length).toBe(3);expect(s.waits).toEqual([100,200])});
it("e",async()=>{const l=R();const s=setup(R(),l);await expect(c(s.gw,5,"k",{sleep:s.sleep,maxAttempts:2,baseDelayMs:10})).rejects.toBe(l);expect(s.waits).toEqual([10])});
it("e2",async()=>{const s=setup(R(),R(),R(),"ok");await c(s.gw,5,"k",{sleep:s.sleep,maxAttempts:4});expect(s.waits).toEqual([100,200,400])});
it("f",async()=>{for(const a of [0,-1,1.5]){const s=setup("ok");await expect(c(s.gw,a,"k",{sleep:s.sleep})).rejects.toThrow(RangeError);expect(s.calls.length).toBe(0)}});
`, bugs: [
 ["new key each attempt", "idempotencyKey: key }", "idempotencyKey: key + \"-\" + attempt }"], ["retries non-retryable", " || !error.retryable", ""],
 ["retries any error", "!(error instanceof GatewayError) || !error.retryable", "error instanceof GatewayError && !error.retryable"],
 ["linear backoff", "baseDelayMs * 2 ** (attempt - 1)", "baseDelayMs * attempt"], ["backoff off by one", "2 ** (attempt - 1)", "2 ** attempt"],
 ["extra attempt", "attempt >= maxAttempts", "attempt > maxAttempts"], ["wraps last error", "if (attempt >= maxAttempts) throw error;", "if (attempt >= maxAttempts) throw new Error(\"failed\");"],
 ["waits after last", "      if (attempt >= maxAttempts) throw error;\n      await opts.sleep(baseDelayMs * 2 ** (attempt - 1));", "      await opts.sleep(baseDelayMs * 2 ** (attempt - 1));\n      if (attempt >= maxAttempts) throw error;"],
 ["attempts wrong", "attempts: attempt }", "attempts: attempt - 1 }"], ["zero allowed", "amountCents <= 0", "amountCents < 0"], ["fractional allowed", "!Number.isInteger(amountCents) || ", ""],
 ["default attempts", "opts.maxAttempts ?? 3", "opts.maxAttempts ?? 4"], ["default base delay", "opts.baseDelayMs ?? 100", "opts.baseDelayMs ?? 50"],
]};
t.csv = { file: "csv", src: `export function parseCsv(text: string, delimiter = ","): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field); field = "";
    } else if (ch === "\\n" || ch === "\\r") {
      if (ch === "\\r" && text[i + 1] === "\\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (quoted) throw new SyntaxError("unterminated quote");
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  return body.map((cells, index) => {
    if (cells.length !== header.length) throw new SyntaxError(\`row \${index + 2} has \${cells.length} fields, expected \${header.length}\`);
    return Object.fromEntries(header.map((name, c) => [name, cells[c]]));
  });
}
`, req: `# CSV parser
- The first row is the header. Each later row becomes an object keyed by header name.
- Fields may be quoted. A quoted field can hold the delimiter, line breaks, and "" meaning one double quote.
- Spaces are kept exactly as written.
- Rows end with \\n or \\r\\n. A final line break does not add a row. Blank lines are skipped.
- The delimiter can be changed. The default is a comma.
- A row with the wrong number of fields throws SyntaxError that names the row number (the header is row 1). An unterminated quote throws SyntaxError.
- Empty input returns an empty list.
`, oracle: `import { it, expect } from "vitest"; import { parseCsv as p } from "../src/csv";
it("a",()=>{expect(p('a,b\\n1,2\\n3,4')).toEqual([{a:"1",b:"2"},{a:"3",b:"4"}])});
it("b",()=>{expect(p('a,b\\n"1,5","x""y"\\n')).toEqual([{a:"1,5",b:'x"y'}])});
it("c",()=>{expect(p('a,b\\n"l1\\nl2",2')).toEqual([{a:"l1\\nl2",b:"2"}])});
it("d",()=>{expect(p('a,b\\r\\n1,2\\r\\n')).toEqual([{a:"1",b:"2"}])});
it("e",()=>{expect(p('a\\n1\\n\\n2\\n')).toEqual([{a:"1"},{a:"2"}])});
it("f",()=>{expect(p('a;b\\n1,2;3','; '.trim())).toEqual([{a:"1,2",b:"3"}])});
it("g",()=>{expect(()=>p('a,b\\n1,2\\n3')).toThrow(/row 3/);expect(()=>p('a,b\\n1,2\\n3')).toThrow(SyntaxError);expect(()=>p('a,b\\n1,2,3')).toThrow(SyntaxError);expect(()=>p('a\\n"x')).toThrow(SyntaxError)});
it("h",()=>{expect(p('')).toEqual([]);expect(p(' a ,b\\n 1, 2 ')).toEqual([{" a ":" 1",b:" 2 "}]);expect(p('a,b\\n,')).toEqual([{a:"",b:""}])});
`, bugs: [
 ["escaped quote dropped", "field += '\"'; i++;", "i++;"], ["delimiter splits quoted", "if (quoted) {", "if (quoted && ch !== delimiter) {"],
 ["line break ends quoted", "else field += ch;\n    } else if (ch === '\"'", "else if (ch === \"\\n\") { quoted = false; row.push(field); field = \"\"; rows.push(row); row = []; }\n      else field += ch;\n    } else if (ch === '\"'"],
 ["CR not a line end", "ch === \"\\n\" || ch === \"\\r\"", "ch === \"\\n\""], ["blank lines kept", "if (row.length > 1 || row[0] !== \"\") rows.push(row);", "rows.push(row);"],
 ["delimiter ignored", "ch === delimiter", "ch === \",\""], ["no field count check", "if (cells.length !== header.length) throw", "if (false) throw"],
 ["wrong row number", "index + 2", "index + 1"], ["unterminated ok", "  if (quoted) throw new SyntaxError(\"unterminated quote\");\n", ""],
 ["trims fields", "row.push(field); field = \"\";\n    } else if (ch === \"\\n\"", "row.push(field.trim()); field = \"\";\n    } else if (ch === \"\\n\""],
 ["last row lost", "if (field !== \"\" || row.length > 0) { row.push(field); rows.push(row); }", ""],
]};
t.access = { file: "access", src: `export type Action = "read" | "write" | "delete" | "share";
export interface User { id: string; role: "admin" | "member"; suspended?: boolean }
export interface Doc { ownerId: string; viewers: string[]; editors: string[]; public?: boolean; archived?: boolean }
export function canAccess(user: User | null, doc: Doc, action: Action): boolean {
  if (user === null) return action === "read" && !!doc.public && !doc.archived;
  if (user.suspended) return false;
  if (user.role === "admin") return true;
  if (doc.archived && action !== "read") return false;
  const owner = doc.ownerId === user.id;
  if (owner) return true;
  if (action === "read") return !!doc.public || doc.viewers.includes(user.id) || doc.editors.includes(user.id);
  if (action === "write") return doc.editors.includes(user.id);
  return false;
}
`, req: `# Document access
- An anonymous visitor (null user) can only read public documents that are not archived.
- A suspended user can do nothing, even an admin.
- An admin can do everything to any document, including archived ones.
- For everyone else, an archived document is read-only, even for its owner.
- The owner can do everything.
- Viewers and editors can read. Anyone signed in can read a public document.
- Only editors can write. Only the owner or an admin can delete or share.
`, oracle: `import { it, expect } from "vitest"; import { canAccess as c } from "../src/access";
const d=(x={})=>({ownerId:"o",viewers:["v"],editors:["e"],...x});const u=(id:string,x={})=>({id,role:"member" as const,...x});const A={id:"a",role:"admin" as const};
it("a",()=>{expect(c(null,d({public:true}),"read")).toBe(true);expect(c(null,d({public:true}),"write")).toBe(false);expect(c(null,d(),"read")).toBe(false);expect(c(null,d({public:true,archived:true}),"read")).toBe(false)});
it("b",()=>{expect(c({...A,suspended:true},d(),"read")).toBe(false);expect(c(u("o",{suspended:true}),d(),"read")).toBe(false)});
it("c",()=>{expect(c(A,d(),"delete")).toBe(true);expect(c(A,d({archived:true}),"write")).toBe(true)});
it("d",()=>{expect(c(u("o"),d({archived:true}),"write")).toBe(false);expect(c(u("o"),d({archived:true}),"read")).toBe(true);expect(c(u("e"),d({archived:true}),"write")).toBe(false)});
it("e",()=>{for(const a of ["read","write","delete","share"] as const)expect(c(u("o"),d(),a)).toBe(true)});
it("f",()=>{expect(c(u("v"),d(),"read")).toBe(true);expect(c(u("e"),d(),"read")).toBe(true);expect(c(u("x"),d(),"read")).toBe(false);expect(c(u("x"),d({public:true}),"read")).toBe(true)});
it("g",()=>{expect(c(u("e"),d(),"write")).toBe(true);expect(c(u("v"),d(),"write")).toBe(false);expect(c(u("x"),d({public:true}),"write")).toBe(false);expect(c(u("e"),d(),"delete")).toBe(false);expect(c(u("e"),d(),"share")).toBe(false)});
`, bugs: [
 ["anon reads private", "action === \"read\" && !!doc.public && !doc.archived", "action === \"read\" && !doc.archived"], ["anon reads archived", " && !doc.archived;", ";"], ["anon any action", "action === \"read\" && !!doc.public", "!!doc.public"],
 ["suspended admin allowed", "if (user.suspended) return false;\n  if (user.role === \"admin\") return true;", "if (user.role === \"admin\") return true;\n  if (user.suspended) return false;"], ["suspended ignored", "  if (user.suspended) return false;\n", ""],
 ["admin blocked on archive", "if (user.role === \"admin\") return true;\n  if (doc.archived && action !== \"read\") return false;", "if (doc.archived && action !== \"read\") return false;\n  if (user.role === \"admin\") return true;"],
 ["owner writes archive", "if (doc.archived && action !== \"read\") return false;\n  const owner = doc.ownerId === user.id;\n  if (owner) return true;", "const owner = doc.ownerId === user.id;\n  if (owner) return true;\n  if (doc.archived && action !== \"read\") return false;"],
 ["editor cannot read", " || doc.editors.includes(user.id);\n  if (action === \"write\")", ";\n  if (action === \"write\")"], ["viewer can write", "action === \"write\") return doc.editors.includes(user.id)", "action === \"write\") return doc.editors.includes(user.id) || doc.viewers.includes(user.id)"],
 ["public not readable", "!!doc.public || doc.viewers", "doc.viewers"], ["editor can delete", "if (action === \"write\") return", "if (action !== \"read\") return"], ["public writable", "action === \"write\") return doc.editors", "action === \"write\") return !!doc.public || doc.editors"],
]};
t.inventory = { file: "inventory", src: `export class Inventory {
  private stock = new Map<string, number>();
  private held = new Map<string, { sku: string; qty: number }>();
  add(sku: string, qty: number) {
    if (qty <= 0) throw new RangeError("qty must be positive");
    this.stock.set(sku, (this.stock.get(sku) ?? 0) + qty);
  }
  available(sku: string): number {
    let reserved = 0;
    for (const hold of this.held.values()) if (hold.sku === sku) reserved += hold.qty;
    return (this.stock.get(sku) ?? 0) - reserved;
  }
  reserve(orderId: string, sku: string, qty: number): boolean {
    if (qty <= 0) throw new RangeError("qty must be positive");
    if (this.held.has(orderId)) throw new Error("order already has a reservation");
    if (this.available(sku) < qty) return false;
    this.held.set(orderId, { sku, qty });
    return true;
  }
  release(orderId: string): boolean {
    return this.held.delete(orderId);
  }
  commit(orderId: string): boolean {
    const hold = this.held.get(orderId);
    if (!hold) return false;
    this.stock.set(hold.sku, this.stock.get(hold.sku)! - hold.qty);
    this.held.delete(orderId);
    return true;
  }
}
`, req: `# Inventory reservations
- add(sku, qty) adds stock. qty must be positive, otherwise throw RangeError.
- available(sku) is stock minus active reservations. An unknown sku has 0 available.
- reserve(orderId, sku, qty) holds qty and returns true if enough is available, otherwise it holds nothing and returns false. qty must be positive. One order can have only one reservation, a second one throws an Error.
- release(orderId) ends a reservation and makes the units available again. It returns false if there is no reservation.
- commit(orderId) removes the reserved units from stock for good and ends the reservation. It returns false if there is no reservation.
- A released or committed order can be reserved again.
`, oracle: `import { it, expect } from "vitest"; import { Inventory as I } from "../src/inventory";
const mk=(q=5)=>{const i=new I();i.add("s",q);return i};
it("a",()=>{const i=mk();i.add("s",2);expect(i.available("s")).toBe(7);expect(i.available("z")).toBe(0);expect(()=>i.add("s",0)).toThrow(RangeError)});
it("b",()=>{const i=mk();expect(i.reserve("o","s",5)).toBe(true);expect(i.available("s")).toBe(0);expect(i.reserve("p","s",1)).toBe(false);expect(i.available("s")).toBe(0)});
it("c",()=>{const i=mk();expect(i.reserve("o","s",6)).toBe(false);expect(i.available("s")).toBe(5);expect(()=>i.reserve("o","s",0)).toThrow(RangeError);expect(i.reserve("o","s",1)).toBe(true);expect(()=>i.reserve("o","s",1)).toThrow(Error);expect(i.available("s")).toBe(4)});
it("d",()=>{const i=mk();i.reserve("o","s",2);expect(i.release("o")).toBe(true);expect(i.available("s")).toBe(5);expect(i.release("o")).toBe(false);expect(i.available("s")).toBe(5)});
it("e",()=>{const i=mk();i.reserve("o","s",2);expect(i.commit("o")).toBe(true);expect(i.available("s")).toBe(3);expect(i.commit("o")).toBe(false);expect(i.available("s")).toBe(3);expect(i.release("o")).toBe(false);expect(i.reserve("o","s",3)).toBe(true);expect(i.available("s")).toBe(0)});
it("f",()=>{const i=mk();i.add("t",1);i.reserve("o","s",2);expect(i.available("t")).toBe(1);expect(i.reserve("p","t",1)).toBe(true);expect(i.available("s")).toBe(3);const k=mk(3);k.reserve("a","s",1);k.reserve("b","s",1);expect(k.available("s")).toBe(1)});
`, bugs: [
 ["add replaces", "(this.stock.get(sku) ?? 0) + qty", "qty"], ["add zero allowed", "    if (qty <= 0) throw new RangeError(\"qty must be positive\");\n    this.stock.set", "    this.stock.set"],
 ["reservations for all skus", "if (hold.sku === sku) reserved", "reserved"], ["unknown sku NaN", "(this.stock.get(sku) ?? 0) - reserved", "this.stock.get(sku)! - reserved"],
 ["boundary", "this.available(sku) < qty", "this.available(sku) <= qty"], ["overbook", "    if (this.available(sku) < qty) return false;\n", ""],
 ["double reserve overwrites", "    if (this.held.has(orderId)) throw new Error(\"order already has a reservation\");\n", ""], ["reserve zero allowed", "    if (qty <= 0) throw new RangeError(\"qty must be positive\");\n    if (this.held", "    if (this.held"],
 ["release always true", "return this.held.delete(orderId);", "this.held.delete(orderId); return true;"], ["release noop", "return this.held.delete(orderId);", "return this.held.has(orderId);"],
 ["commit keeps stock", "    this.stock.set(hold.sku, this.stock.get(hold.sku)! - hold.qty);\n", ""], ["commit keeps hold", "    this.held.delete(orderId);\n    return true;\n  }\n}", "    return true;\n  }\n}"], ["commit missing true", "if (!hold) return false;", "if (!hold) return true;"],
]};
// seeded: src contains a bug that contradicts the requirements; ref is the correct code.
t.loyalty = { file: "loyalty", seeded: true, src: `export type Tier = "basic" | "silver" | "gold";
export function pointsFor(amount: number, tier: Tier, firstOrder = false): number {
  if (amount < 0) throw new RangeError("amount must not be negative");
  const base = Math.floor(amount);
  const multiplier = tier === "gold" ? 2 : tier === "silver" ? 1.5 : 1;
  let points = Math.floor(base * multiplier);
  if (firstOrder) points += 100;
  if (amount > 200) points += 50;
  return points;
}
`, ref: [["amount > 200", "amount >= 200"]], req: `# Loyalty points
- One point for each whole dollar. A negative amount throws RangeError.
- Silver earns 1.5x and gold earns 2x, rounded down.
- A first order earns 100 extra points.
- An order of $200 or more earns 50 extra points.
`, oracle: `import { it, expect } from "vitest"; import { pointsFor as p } from "../src/loyalty";
it("a",()=>{expect(p(200,"basic")).toBe(250);expect(p(199.99,"basic")).toBe(199);expect(p(3,"silver")).toBe(4);expect(p(3,"gold",true)).toBe(106)});`, bugs: []};
t.password = { file: "password", seeded: true, src: `export function checkPassword(password: string, username: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push("too short");
  if (!/[A-Z]/.test(password)) problems.push("needs uppercase");
  if (!/[a-z]/.test(password)) problems.push("needs lowercase");
  if (!/[0-9]/.test(password)) problems.push("needs digit");
  if (password.includes(username)) problems.push("contains username");
  return problems;
}
`, ref: [["password.includes(username)", "password.toLowerCase().includes(username.toLowerCase())"]], req: `# Password policy
checkPassword returns a list of problems. An empty list means the password is accepted.
- At least 12 characters: "too short".
- At least one uppercase letter: "needs uppercase". One lowercase letter: "needs lowercase". One digit: "needs digit".
- It must not contain the username, ignoring upper and lower case: "contains username".
`, oracle: `import { it, expect } from "vitest"; import { checkPassword as c } from "../src/password";
it("a",()=>{expect(c("Abcdefghijk1","zed")).toEqual([]);expect(c("Abcdefghij1","zed")).toEqual(["too short"]);expect(c("xxAliCExxxx1A","alice")).toEqual(["contains username"])});`, bugs: []};
export default t;

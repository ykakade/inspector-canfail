# Fake tests: one example per rule

Each rule below has a test that passes but cannot fail, and the fix. `canfail scan` finds all twelve. `canfail rules` prints the short form.

The examples test this function:

```ts
export function total(items: { price: number; qty: number }[], coupon?: string): number
```

## Errors: the test cannot fail

### mocks-subject

The file mocks the module it tests. Every call goes to the mock.

```ts
// cart.test.ts
vi.mock("./cart", () => ({ total: vi.fn(() => 30) }));
it("adds prices", () => expect(total([{ price: 10, qty: 3 }])).toBe(30));
```

Fix: delete the mock. Mock only what `cart.ts` imports, and only at a boundary.

### everything-mocked

Every project module the test imports is mocked. No real code runs.

```ts
vi.mock("../src/pricing");
vi.mock("../src/tax");
import { price } from "../src/pricing";
import { tax } from "../src/tax";
```

Fix: import at least one real module and test it.

### tests-the-mock

The test calls a mock and checks the same mock.

```ts
const send = vi.fn();
it("sends a receipt", () => {
  send("ada@example.com");
  expect(send).toHaveBeenCalledWith("ada@example.com");
});
```

Fix: give the mock to the real code. Check how the real code used it.

```ts
it("sends a receipt", async () => {
  const mailer = { send: vi.fn() };
  await checkout(order, mailer);
  expect(mailer.send).toHaveBeenCalledWith("ada@example.com");
});
```

### no-assertion

```ts
it("computes the total", () => {
  total([{ price: 10, qty: 3 }]);
});
```

Fix: `expect(total([{ price: 10, qty: 3 }])).toBe(30);`

### tautology

```ts
it("works", () => expect(true).toBe(true));
it("is stable", () => expect(total(items)).toEqual(total(items)));
```

Fix: compare the real output with a value you worked out by hand.

### dangling-expect

`toBeTruthy` without `()` is a property read. It checks nothing.

```ts
expect(total(items)).toBeTruthy;
expect(total(items));
```

Fix: call a matcher with an exact value: `expect(total(items)).toBe(30);`

### swallowed-failure

The `catch` catches the assertion error too.

```ts
try {
  expect(total(items)).toBe(30);
} catch (error) {
  console.warn(error);
}
```

Fix: remove the `try/catch`.

### unchecked-throw

If `total` stops throwing, the `catch` never runs and the test passes.

```ts
it("rejects an empty cart", () => {
  try {
    total([]);
  } catch (error) {
    expect(error.message).toBe("Cart is empty");
  }
});
```

Fix: `expect(() => total([])).toThrow("Cart is empty");`

### floating-assertion

The test ends before the assertion runs.

```ts
it("loads the cart", () => {
  expect(loadCart(1)).resolves.toEqual({ id: 1 });
  loadCart(1).then((cart) => expect(cart.id).toBe(1));
});
```

Fix: `await expect(loadCart(1)).resolves.toEqual({ id: 1 });`

## Warnings: the test can fail, but barely

### skipped-test

```ts
it.skip("gives half off from $100", () => { /* ... */ });
```

A skipped test does not run, and the run is still green. Fix the test, or delete it and tell the user why.

### weak-assertion

```ts
expect(total(items)).toBeDefined();
expect(typeof total(items)).toBe("number");
expect(total(items)).not.toBeNull();
```

These pass for almost any value, also for a wrong one. Fix: `expect(total(items)).toBe(30);`

### conditional-assertion

```ts
const t = total(items);
if (t > 100) {
  expect(t).toBe(105);
}
```

When the condition is false, nothing is checked. Fix: assert the condition, then the value.

## Silence one finding

Some findings are on purpose. Add a comment on the line, or the line above, with the rule and the reason:

```ts
// canfail-ignore tautology: documents a platform guarantee
expect(0.1 + 0.2).not.toBe(0.3);
```

The same comment in source code (`// canfail-ignore`) stops `prove` from planting bugs on that line.

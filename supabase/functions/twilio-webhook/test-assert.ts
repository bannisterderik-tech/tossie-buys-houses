// supabase/functions/twilio-webhook/test-assert.ts
// ============================================================================
// The four assertions the suites in this directory need. Nothing else.
// ============================================================================
// Not node:assert, which scripts/api-test.mjs uses under Node: type-checking a
// `node:` specifier under Deno pulls @types/node from npm, and this repo takes
// no dependency it does not need — least of all one that turns `deno test` into
// something that fails on a machine with no network.
//
// Not jsr:@std/assert either, for the same reason. Twenty lines is cheaper than
// a lockfile, and these run type-checked rather than under --no-check, which is
// the point of writing them.
// ============================================================================

export function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

export function equal(actual: unknown, expected: unknown, msg = ''): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${msg ? `${msg}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function notEqual(actual: unknown, unexpected: unknown, msg = ''): void {
  if (Object.is(actual, unexpected)) {
    throw new Error(`${msg ? `${msg}: ` : ''}expected anything but ${JSON.stringify(unexpected)}`);
  }
}

/** Structural comparison, via JSON — every value these suites compare is JSON. */
export function deepEqual(actual: unknown, expected: unknown, msg = ''): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg ? `${msg}: ` : ''}expected ${b}, got ${a}`);
}

export function match(actual: string, re: RegExp, msg = ''): void {
  if (!re.test(actual)) {
    throw new Error(`${msg ? `${msg}: ` : ''}${re} does not match ${JSON.stringify(actual)}`);
  }
}

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mintPaypalToken } from "./paypal-auth.ts";

const SAVED = { id: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET };
beforeEach(() => { delete process.env.PAYPAL_CLIENT_ID; delete process.env.PAYPAL_CLIENT_SECRET; });
afterEach(() => {
  if (SAVED.id) process.env.PAYPAL_CLIENT_ID = SAVED.id; else delete process.env.PAYPAL_CLIENT_ID;
  if (SAVED.secret) process.env.PAYPAL_CLIENT_SECRET = SAVED.secret; else delete process.env.PAYPAL_CLIENT_SECRET;
});

test("mintPaypalToken throws a clear error when credentials are missing (no network)", async () => {
  await expect(mintPaypalToken("paypal-test-missing")).rejects.toThrow(/missing Client ID/i);
});

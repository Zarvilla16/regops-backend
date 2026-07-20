import { errorCodeForField, transactionRowSchema } from "./transaction-row.schema";

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    cbs_transaction_id: "TXN-001",
    customer_cbs_id: "CUST-001",
    account_number: "0123456789",
    amount: "100000.00",
    currency: "NGN",
    type: "CREDIT",
    channel: "MOBILE",
    occurred_at: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("transactionRowSchema", () => {
  it("happy path: accepts a fully valid row", () => {
    const result = transactionRowSchema.safeParse(validRow());
    expect(result.success).toBe(true);
  });

  it("happy path: accepts a numeric amount (webhook/JSON path) as well as a string amount (CSV path)", () => {
    const result = transactionRowSchema.safeParse(validRow({ amount: 100000 }));
    expect(result.success).toBe(true);
  });

  it("rejects a row missing a required field", () => {
    const { cbs_transaction_id: _omit, ...withoutId } = validRow();
    const result = transactionRowSchema.safeParse(withoutId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(errorCodeForField(String(result.error.issues[0].path[0]))).toBe("MISSING_CBS_TRANSACTION_ID");
    }
  });

  it("rejects a zero amount", () => {
    const result = transactionRowSchema.safeParse(validRow({ amount: "0" }));
    expect(result.success).toBe(false);
  });

  it("rejects a negative amount", () => {
    const result = transactionRowSchema.safeParse(validRow({ amount: "-500" }));
    expect(result.success).toBe(false);
  });

  it("rejects an invalid currency code", () => {
    const result = transactionRowSchema.safeParse(validRow({ currency: "N" }));
    expect(result.success).toBe(false);
  });

  it("rejects an unknown transaction type", () => {
    const result = transactionRowSchema.safeParse(validRow({ type: "REFUND" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(errorCodeForField(String(result.error.issues[0].path[0]))).toBe("INVALID_TYPE");
    }
  });

  it("rejects an unknown channel", () => {
    const result = transactionRowSchema.safeParse(validRow({ channel: "CRYPTO" }));
    expect(result.success).toBe(false);
  });

  it("rejects a missing occurred_at", () => {
    const result = transactionRowSchema.safeParse(validRow({ occurred_at: "" }));
    expect(result.success).toBe(false);
  });

  it("errorCodeForField falls back to INVALID_ROW for an unmapped field", () => {
    expect(errorCodeForField("some_unmapped_field")).toBe("INVALID_ROW");
  });
});

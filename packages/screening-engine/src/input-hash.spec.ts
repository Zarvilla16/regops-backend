import { computeInputHash } from "./input-hash";

describe("computeInputHash", () => {
  it("is deterministic for identical input", () => {
    const input = { fullName: "John Doe", country: "NG" };
    expect(computeInputHash(input)).toBe(computeInputHash({ ...input }));
  });

  it("normalizes case and whitespace in fullName", () => {
    const a = computeInputHash({ fullName: "  John   Doe  " });
    const b = computeInputHash({ fullName: "john doe" });
    expect(a).toBe(b);
  });

  it("normalizes country/nationality casing", () => {
    const a = computeInputHash({ fullName: "John Doe", country: "ng", nationality: "ng" });
    const b = computeInputHash({ fullName: "John Doe", country: "NG", nationality: "NG" });
    expect(a).toBe(b);
  });

  it("normalizes dateOfBirth to a date-only value regardless of time component", () => {
    const a = computeInputHash({ fullName: "John Doe", dateOfBirth: new Date("1990-01-01T00:00:00Z") });
    const b = computeInputHash({ fullName: "John Doe", dateOfBirth: new Date("1990-01-01T23:59:59Z") });
    expect(a).toBe(b);
  });

  it("produces a different hash when fullName differs", () => {
    const a = computeInputHash({ fullName: "John Doe" });
    const b = computeInputHash({ fullName: "Jane Doe" });
    expect(a).not.toBe(b);
  });

  it("produces a different hash when bvn differs", () => {
    const a = computeInputHash({ fullName: "John Doe", bvn: "12345678901" });
    const b = computeInputHash({ fullName: "John Doe", bvn: "10987654321" });
    expect(a).not.toBe(b);
  });
});

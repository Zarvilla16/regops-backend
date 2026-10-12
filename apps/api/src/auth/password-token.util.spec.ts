import { generatePasswordToken, hashPasswordToken } from "./password-token.util";

describe("password token helpers", () => {
  it("returns a token and the hash that is stored in its place", () => {
    const { token, tokenHash } = generatePasswordToken();
    expect(tokenHash).toBe(hashPasswordToken(token));
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates URL-safe, high-entropy, never-repeating tokens", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generatePasswordToken().token));
    expect(tokens.size).toBe(200);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("hashes deterministically", () => {
    expect(hashPasswordToken("abc")).toBe(hashPasswordToken("abc"));
    expect(hashPasswordToken("abc")).not.toBe(hashPasswordToken("abd"));
  });
});

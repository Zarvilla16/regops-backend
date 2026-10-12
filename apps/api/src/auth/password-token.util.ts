import * as crypto from "crypto";

/** A fresh random secret to e-mail to a user, plus the hash that is stored instead of it. */
export function generatePasswordToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashPasswordToken(token) };
}

export function hashPasswordToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
export const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Don't send a second reset mail for the same account within this window (stops mail-bombing a user). */
export const RESET_REQUEST_COOLDOWN_MS = 60 * 1000;

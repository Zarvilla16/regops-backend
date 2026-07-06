import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { authenticator } from "otplib";
import * as QRCode from "qrcode";
import * as crypto from "crypto";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";

@Injectable()
export class MfaService {
  constructor(private readonly configService: ConfigService) {}

  generateSecret(): string {
    return authenticator.generateSecret();
  }

  async generateQrCode(email: string, secret: string): Promise<string> {
    const issuer = this.configService.get<string>("mfaIssuer");
    const otpauthUrl = authenticator.keyuri(email, issuer ?? "RegOps", secret);
    return QRCode.toDataURL(otpauthUrl);
  }

  verifyCode(secret: string, code: string): boolean {
    try {
      return authenticator.check(code, secret);
    } catch {
      return false;
    }
  }

  /**
   * mfa_secret is stored encrypted at rest. The encryption key is derived
   * from JWT_ACCESS_SECRET for phase 0; production deployments should use a
   * dedicated key from a KMS instead.
   */
  encryptSecret(plainSecret: string): string {
    const key = this.deriveKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plainSecret, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
  }

  decryptSecret(cipherText: string): string {
    const [ivHex, authTagHex, encryptedHex] = cipherText.split(":");
    const key = this.deriveKey();
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, "hex")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  }

  private deriveKey(): Buffer {
    const secret = this.configService.get<string>("jwt.accessSecret") ?? "";
    return crypto.scryptSync(secret, "regops-mfa-secret-encryption", 32);
  }
}

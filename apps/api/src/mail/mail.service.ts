import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends transactional mail through Resend's HTTP API (no SDK, one POST). Configure with RESEND_API_KEY and
 * MAIL_FROM (an address on a domain verified in Resend).
 *
 * Without RESEND_API_KEY nothing is sent: outside production the message is logged in full (so links can be
 * copied in local development); in production only a warning without the body is logged, because the body holds
 * a live secret link. send() never throws: a mail outage must not break the request that triggered it, nor reveal
 * (via an error) whether an address exists.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly configService: ConfigService) {}

  /** True when mail will actually leave the system. */
  isConfigured(): boolean {
    return Boolean(this.configService.get<string>("mail.resendApiKey"));
  }

  async send(mail: OutgoingMail): Promise<boolean> {
    const apiKey = this.configService.get<string>("mail.resendApiKey");
    const from = this.configService.get<string>("mail.from");

    if (!apiKey) {
      if (this.configService.get<string>("nodeEnv") === "production") {
        this.logger.warn(`Mail not sent to ${mail.to}: RESEND_API_KEY is not configured ("${mail.subject}").`);
      } else {
        this.logger.log(`[mail disabled] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
      }
      return false;
    }

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.logger.error(`Resend rejected mail to ${mail.to}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Sending mail to ${mail.to} failed: ${(err as Error).message}`);
      return false;
    }
  }
}

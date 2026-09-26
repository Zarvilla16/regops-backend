import { Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import PDFDocument from "pdfkit";
import { CaseEntity, CustomerEntity, ReportEntity, TenantEntity, TransactionEntity, UserEntity } from "@regops/db";
import { AuthUserContext, ReportType } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { CasesService } from "../cases/cases.service";
import { RequestMeta } from "../users/users.service";
import { ReportsService } from "./reports.service";

/** Stamped into every XML export. Section 2.4: this output is NOT goAML-schema-valid and must never be described as such. */
export const XML_DISCLAIMER =
  "INTERNAL EXPORT - NOT GOAML SCHEMA CONFORMANT. This document has not been validated against the NFIU goAML XSD and " +
  "is not suitable for direct filing with the NFIU.";

export type ReportExportFormat = "xml" | "pdf" | "csv";

export interface ReportExport {
  body: Buffer | string;
  contentType: string;
  fileName: string;
}

interface Officer {
  id: string;
  fullName: string;
  email: string;
}

interface ExportData {
  report: ReportEntity;
  tenant: TenantEntity | null;
  customer: CustomerEntity | null;
  kase: CaseEntity | null;
  transactions: TransactionEntity[];
  officers: { generatedBy: Officer | null; submittedBy: Officer | null; confirmedBy: Officer | null };
}

/**
 * Section 3.7. XML is materially fuller than the frontend mock's placeholder
 * (real customer demographics incl. unmasked BVN/NIN, full transaction
 * records, structured amount/date/account fields) but is explicitly NOT
 * goAML-schema-valid — see XML_DISCLAIMER and HANDOFF.md's Known Issues for
 * exactly what is missing. PDF/CSV are simpler internal-recordkeeping exports
 * and keep BVN/NIN masked.
 */
@Injectable()
export class ReportExportService {
  constructor(
    private readonly auditService: AuditService,
    private readonly reportsService: ReportsService,
    private readonly casesService: CasesService,
  ) {}

  async export(qr: QueryRunner, tenantId: string, id: string, format: ReportExportFormat, currentUser: AuthUserContext, meta: RequestMeta, reason?: string): Promise<ReportExport> {
    const data = await this.load(qr, tenantId, id);
    const { report } = data;
    const baseName = `${report.reportType}-${report.id.slice(0, 8)}`;

    // Audit-log the download itself, and — for XML — the BVN/NIN unmask, using the
    // exact same action name the PII-reveal endpoint (GET /customers/:id/pii) uses so
    // one audit query finds every place unmasked PII left the system.
    await this.auditService.record(qr, {
      tenantId,
      userId: currentUser.sub,
      action: "report.exported",
      entityType: "report",
      entityId: id,
      afterState: { format, reportType: report.reportType, status: report.status, ...(reason ? { reason } : {}) },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    if (format === "xml") {
      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "customer.pii.view",
        entityType: "customer",
        entityId: report.customerId,
        afterState: { reason, reportId: id, fields: ["bvn", "nin"] },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
    }

    switch (format) {
      case "xml":
        return { body: this.buildXml(data), contentType: "application/xml; charset=utf-8", fileName: `${baseName}.xml` };
      case "csv":
        return { body: this.buildCsv(data), contentType: "text/csv; charset=utf-8", fileName: `${baseName}.csv` };
      case "pdf":
        return { body: await this.buildPdf(data), contentType: "application/pdf", fileName: `${baseName}.pdf` };
    }
  }

  // ------------------------------------------------------------------ data

  private async load(qr: QueryRunner, tenantId: string, id: string): Promise<ExportData> {
    const report = await this.reportsService.findEntity(qr, tenantId, id);
    const tenant = await qr.manager.getRepository(TenantEntity).findOne({ where: { id: tenantId } });
    const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { id: report.customerId, tenantId } });

    let kase: CaseEntity | null = null;
    let transactions: TransactionEntity[] = [];
    if (report.reportType === ReportType.SAR && report.caseId) {
      kase = await qr.manager.getRepository(CaseEntity).findOne({ where: { id: report.caseId, tenantId } });
      // Same derivation CasesService.toDetail() uses (linked alerts -> evidence.relatedTransactionIds, deduped, by occurredAt).
      const derived = await this.casesService.getDerivedTransactions(qr, tenantId, report.caseId);
      if (derived.length > 0) {
        const rows = await qr.manager
          .getRepository(TransactionEntity)
          .createQueryBuilder("t")
          .where("t.tenant_id = :tenantId", { tenantId })
          .andWhere("t.id IN (:...ids)", { ids: derived.map((d) => d.id) })
          .getMany();
        transactions = rows.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
      }
    } else if (report.transactionId) {
      const t = await qr.manager.getRepository(TransactionEntity).findOne({ where: { id: report.transactionId, tenantId } });
      if (t) transactions = [t];
    }

    const officer = async (uid: string | null): Promise<Officer | null> => {
      if (!uid) return null;
      const u = await qr.manager.getRepository(UserEntity).findOne({ where: { id: uid, tenantId } });
      return u ? { id: u.id, fullName: u.fullName, email: u.email } : null;
    };

    return {
      report,
      tenant,
      customer,
      kase,
      transactions,
      officers: {
        generatedBy: await officer(report.generatedBy),
        submittedBy: await officer(report.submittedBy),
        confirmedBy: await officer(report.confirmedBy),
      },
    };
  }

  // ------------------------------------------------------------------- XML

  private buildXml(d: ExportData): string {
    const { report, tenant, customer, kase, transactions, officers } = d;
    const isSar = report.reportType === ReportType.SAR;
    const root = isSar ? "suspicious_activity_report" : "currency_transaction_report";
    const currency = transactions[0]?.currency ?? "NGN";
    const iso = (dt: Date | null) => (dt ? dt.toISOString() : null);

    const el = (name: string, value: string | number | null | undefined, indent: string, attrs = ""): string =>
      value === null || value === undefined || value === "" ? "" : `${indent}<${name}${attrs}>${xmlEscape(String(value))}</${name}>\n`;

    const officerEl = (name: string, o: Officer | null, id: string | null, at: Date | null): string => {
      if (!id) return "";
      return (
        `    <${name}>\n` +
        el("user_id", id, "      ") +
        el("full_name", o?.fullName, "      ") +
        el("email", o?.email, "      ") +
        el("at", iso(at), "      ") +
        `    </${name}>\n`
      );
    };

    let x = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${xmlComment(XML_DISCLAIMER)} -->\n<${root}>\n`;

    x += "  <report>\n";
    x += el("report_reference", report.id, "    ");
    x += el("report_type", report.reportType, "    ");
    x += el("status", report.status, "    ");
    x += el("generated_at", iso(report.generatedAt), "    ");
    x += el("nfiu_reference", report.nfiuReference, "    ");
    x += "  </report>\n";

    x += "  <reporting_entity>\n";
    x += el("name", tenant?.name, "    ");
    x += el("institution_type", tenant?.type, "    ");
    x += el("cbn_license_number", tenant?.cbnLicenseNumber, "    ");
    x += "    <!-- Other reporting-institution regulatory identifiers required by goAML are not captured. -->\n";
    x += "  </reporting_entity>\n";

    x += "  <reporting_officers>\n";
    x += officerEl("generated_by", officers.generatedBy, report.generatedBy, report.generatedAt);
    x += officerEl("submitted_by", officers.submittedBy, report.submittedBy, report.submittedAt);
    x += officerEl("confirmed_by", officers.confirmedBy, report.confirmedBy, report.confirmedAt);
    x += "    <!-- Regulatory-facing officer identity beyond name/email is not captured. -->\n";
    x += "  </reporting_officers>\n";

    x += "  <subject>\n";
    x += el("customer_id", report.customerId, "    ");
    x += el("cbs_customer_id", customer?.cbsCustomerId, "    ");
    x += el("full_name", customer?.fullName, "    ");
    x += el("customer_type", customer?.customerType, "    ");
    x += el("date_of_birth", customer?.dateOfBirth ? toDateOnly(customer.dateOfBirth) : null, "    ");
    x += el("nationality", customer?.nationality, "    ");
    x += el("country", customer?.country, "    ");
    x += el("occupation", customer?.occupation, "    ");
    x += el("bvn", customer?.bvn, "    ");
    x += el("nin", customer?.nin, "    ");
    x += "    <!-- Address is not captured on the Customer record. -->\n";
    x += "  </subject>\n";

    x += "  <amounts>\n";
    x += el(isSar ? "flagged_amount" : "transaction_amount", report.flaggedAmount, "    ", ` currency="${xmlEscape(currency)}"`);
    x += "  </amounts>\n";

    if (isSar && kase) {
      x += "  <case>\n";
      x += el("case_number", kase.caseNumber, "    ");
      x += el("escalation_rationale", kase.escalationRationale, "    ");
      x += "  </case>\n";
    }

    x += `  <transactions count="${transactions.length}">\n`;
    for (const t of transactions) {
      x += "    <transaction>\n";
      x += el("transaction_id", t.id, "      ");
      x += el("cbs_transaction_id", t.cbsTransactionId, "      ");
      x += el("date", t.occurredAt.toISOString(), "      ");
      x += el("type", t.type, "      ");
      x += el("channel", t.channel, "      ");
      x += el("amount", t.amount, "      ", ` currency="${xmlEscape(t.currency)}"`);
      x += el("account_number", t.accountNumber, "      ");
      x += el("counterparty_account", t.counterpartyAccount, "      ");
      x += el("counterparty_bank", t.counterpartyBank, "      ");
      x += el("counterparty_name", t.counterpartyName, "      ");
      x += el("reference", t.reference, "      ");
      x += el("narration", t.narration, "      ");
      x += "    </transaction>\n";
    }
    x += "  </transactions>\n";

    x += el("narrative", report.narrative, "  ");
    x += `</${root}>\n`;
    return x;
  }

  // ------------------------------------------------------------------- CSV

  private buildCsv(d: ExportData): string {
    const { report, tenant, customer, kase, transactions } = d;
    const rows: (string | number | null)[][] = [
      ["field", "value"],
      ["report_id", report.id],
      ["report_type", report.reportType],
      ["status", report.status],
      ["generated_at", report.generatedAt.toISOString()],
      ["nfiu_reference", report.nfiuReference],
      ["reporting_entity", tenant?.name ?? null],
      ["customer_name", customer?.fullName ?? null],
      ["cbs_customer_id", customer?.cbsCustomerId ?? null],
      ["bvn_masked", maskId(customer?.bvn ?? null)],
      ["nin_masked", maskId(customer?.nin ?? null)],
      ["case_number", kase?.caseNumber ?? null],
      ["flagged_amount", report.flaggedAmount],
      ["narrative", report.narrative],
      [],
      ["transaction_id", "cbs_transaction_id", "occurred_at", "type", "channel", "amount", "currency", "account_number", "counterparty_name", "reference"],
      ...transactions.map((t) => [
        t.id,
        t.cbsTransactionId,
        t.occurredAt.toISOString(),
        t.type,
        t.channel,
        t.amount,
        t.currency,
        t.accountNumber,
        t.counterpartyName,
        t.reference,
      ]),
    ];
    return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  // ------------------------------------------------------------------- PDF

  private buildPdf(d: ExportData): Promise<Buffer> {
    const { report, tenant, customer, kase, transactions } = d;
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: "A4", info: { Title: `${report.reportType} ${report.id}` } });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const line = (label: string, value: string | null | undefined) => {
        if (value === null || value === undefined || value === "") return;
        doc.font("Helvetica-Bold").text(`${label}: `, { continued: true }).font("Helvetica").text(pdfSafe(value));
      };

      doc.font("Helvetica-Bold").fontSize(16).text(report.reportType === ReportType.SAR ? "Suspicious Activity Report" : "Currency Transaction Report");
      doc.moveDown(0.3).font("Helvetica").fontSize(9).fillColor("#666").text("Internal record - not a regulatory filing.").fillColor("#000");
      doc.moveDown().fontSize(10);

      line("Report ID", report.id);
      line("Status", report.status);
      line("Generated", report.generatedAt.toISOString());
      line("NFIU reference", report.nfiuReference);
      line("Reporting entity", tenant?.name);
      doc.moveDown();
      line("Customer", customer?.fullName);
      line("CBS customer ID", customer?.cbsCustomerId);
      line("BVN", maskId(customer?.bvn ?? null));
      line("NIN", maskId(customer?.nin ?? null));
      line("Case", kase?.caseNumber);
      line("Flagged amount", report.flaggedAmount ? `NGN ${Number(report.flaggedAmount).toLocaleString("en-NG", { minimumFractionDigits: 2 })}` : null);

      doc.moveDown().font("Helvetica-Bold").text("Narrative");
      doc.font("Helvetica").text(pdfSafe(report.narrative ?? "(none)"));

      doc.moveDown().font("Helvetica-Bold").text(`Transactions (${transactions.length})`);
      doc.font("Helvetica").fontSize(9);
      for (const t of transactions) {
        doc.text(
          pdfSafe(
            `${t.occurredAt.toISOString().slice(0, 10)}  ${t.type}  ${t.channel}  ${t.currency} ${Number(t.amount).toLocaleString("en-NG", { minimumFractionDigits: 2 })}  acct ${t.accountNumber}  ref ${t.cbsTransactionId}`,
          ),
        );
      }
      doc.end();
    });
  }
}

// ------------------------------------------------------------------- helpers

/** XML 1.0 forbids most control characters even when escaped — strip them, then escape the five predefined entities. */
function xmlEscape(s: string): string {
  return Array.from(s)
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return !(c <= 0x08 || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f) || c === 0xfffe || c === 0xffff);
    })
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * pdfkit's built-in Helvetica is WinAnsi (Latin-1-ish) only: "₦" (naira) renders as "¦" and Yoruba/Igbo
 * diacritics (ọ, ṣ, ẹ ...) as garbage. Bundling a Unicode font is out of scope, so the internal-recordkeeping PDF
 * transliterates instead: naira -> "NGN ", unrenderable letters reduced to their base letter, anything else -> "?".
 * XML and CSV keep full Unicode. Exported for unit testing.
 */
export function pdfSafe(s: string): string {
  const renderable = (c: number) => c === 0x0a || c === 0x09 || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff);
  const isCombiningMark = (c: number) => c >= 0x300 && c <= 0x36f;
  return Array.from(s.split(String.fromCharCode(0x20a6)).join("NGN "))
    .map((ch) => {
      if (renderable(ch.codePointAt(0) as number)) return ch;
      const base = Array.from(ch.normalize("NFD"))
        .filter((b) => !isCombiningMark(b.codePointAt(0) as number))
        .join("");
      return base.length > 0 && Array.from(base).every((b) => renderable(b.codePointAt(0) as number)) ? base : "?";
    })
    .join("");
}

/** "--" is illegal inside an XML comment. */
function xmlComment(s: string): string {
  return s.replace(/--+/g, "-");
}

function toDateOnly(d: Date | string): string {
  return (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
}

function maskId(v: string | null): string | null {
  if (!v) return null;
  return "*".repeat(Math.max(0, v.length - 4)) + v.slice(-4);
}

/** RFC 4180 quoting, plus a leading apostrophe on cells a spreadsheet would evaluate as a formula (narrative is free user text). */
function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

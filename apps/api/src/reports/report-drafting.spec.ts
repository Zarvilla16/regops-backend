import { TransactionChannel } from "@regops/shared";
import { buildCtrNarrative, buildSarNarrative, computeSarFlaggedAmount, formatNaira, sumAmounts } from "./report-drafting";
import { pdfSafe } from "./report-export.service";

describe("report-drafting", () => {
  describe("sumAmounts / computeSarFlaggedAmount", () => {
    it("sums decimal strings exactly (no float drift)", () => {
      expect(sumAmounts(["0.1", "0.2"])).toBe("0.30");
      expect(sumAmounts(["1000.10", "2000.20", "500"])).toBe("3500.30");
    });

    it("returns null when there are no transactions, a figure otherwise", () => {
      expect(computeSarFlaggedAmount([])).toBeNull();
      expect(computeSarFlaggedAmount([{ amount: "12.5" }])).toBe("12.50");
    });
  });

  describe("buildSarNarrative", () => {
    it("orders notes chronologically regardless of input order, then appends the rationale", () => {
      const n = buildSarNarrative({
        caseNumber: "CASE-2026-0042",
        notes: [
          { at: new Date("2026-03-02T10:00:00Z"), authorName: "B", content: "later" },
          { at: new Date("2026-03-01T10:00:00Z"), authorName: "A", content: "earlier" },
        ],
        escalationRationale: "Because.",
      });
      expect(n).toContain("CASE-2026-0042");
      expect(n.indexOf("earlier")).toBeLessThan(n.indexOf("later"));
      expect(n.indexOf("later")).toBeLessThan(n.indexOf("Because."));
      expect(n).toContain("[2026-03-01 10:00 UTC] A: earlier");
    });

    it("is still a usable starting point with no notes and no rationale", () => {
      expect(buildSarNarrative({ caseNumber: "CASE-1", notes: [], escalationRationale: null })).toBe("Suspicious activity report for case CASE-1.");
    });
  });

  describe("buildCtrNarrative / formatNaira", () => {
    it("states amount, customer, date, channel and the threshold applied", () => {
      const n = buildCtrNarrative({
        amount: "6000000",
        customerName: "Ada Obi",
        occurredAt: new Date("2026-03-15T10:00:00Z"),
        channel: TransactionChannel.CASH,
        threshold: 5_000_000,
      });
      expect(n).toBe("Cash transaction of ₦6,000,000.00 by Ada Obi on 2026-03-15 via CASH, exceeding the ₦5,000,000.00 reporting threshold.");
      expect(formatNaira(1234.5)).toBe("₦1,234.50");
    });
  });
});

describe("pdfSafe", () => {
  it("transliterates the naira sign, which Helvetica/WinAnsi cannot render", () => {
    expect(pdfSafe("Cash of ₦5,000,000.00")).toBe("Cash of NGN 5,000,000.00");
  });

  it("reduces letters Helvetica cannot draw (Yoruba/Igbo dot-below etc.) to their base letter and keeps Latin-1 letters as-is", () => {
    expect(pdfSafe("Ọlá Ṣadé")).toBe("Olá Sadé");
    expect(pdfSafe("José Müller")).toBe("José Müller");
  });

  it("replaces anything still unrenderable with '?', keeping newlines", () => {
    expect(pdfSafe("a\nb 漢")).toBe("a\nb ?");
  });
});

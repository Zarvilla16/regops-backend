import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { AlertEntity, CaseApprovalEventEntity, CaseAlertEntity, CaseAssignmentEventEntity, CaseEntity } from "@regops/db";
import { CaseApprovalOutcome, CaseStatus, CaseTimelineEventDto } from "@regops/shared";
import { CasesService } from "./cases.service";

/** "UNDER_REVIEW" -> "Under Review" — same shape as the mock's humanizeEnum (format.ts). */
function humanizeEnum(value: string): string {
  return value
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

/** Same shape as the mock's formatNGN (format.ts). */
function formatNGN(amount: number | string): string {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 }).format(Number(amount));
}

@Injectable()
export class CaseTimelineService {
  constructor(
    @Inject(forwardRef(() => CasesService))
    private readonly casesService: CasesService,
  ) {}

  /** Section 3.8 — exact event list, sorted chronologically by `at`. */
  async build(qr: QueryRunner, tenantId: string, kase: CaseEntity): Promise<CaseTimelineEventDto[]> {
    const events: CaseTimelineEventDto[] = [];

    const caseAlerts = await qr.manager.getRepository(CaseAlertEntity).find({ where: { tenantId, caseId: kase.id } });
    const alertIds = caseAlerts.map((ca) => ca.alertId);
    const alerts = alertIds.length
      ? await qr.manager
          .getRepository(AlertEntity)
          .createQueryBuilder("a")
          .where("a.tenant_id = :tenantId", { tenantId })
          .andWhere("a.id IN (:...alertIds)", { alertIds })
          .getMany()
      : [];
    const alertById = new Map(alerts.map((a) => [a.id, a]));

    // 1. Opened — alerts whose linked_at exactly equals case.created_at were
    // part of the creation payload (see CasesService.create's docblock on
    // why they share one `now`); anything later is a genuine post-creation link (event 5).
    const creationTimeLinks = caseAlerts.filter((ca) => ca.linkedAt.getTime() === kase.createdAt.getTime());
    const creationTimeTitles = creationTimeLinks.map((ca) => alertById.get(ca.alertId)?.title).filter((t): t is string => Boolean(t));
    events.push({ type: "opened", at: kase.createdAt.toISOString(), actor: kase.createdBy, text: this.openedText(creationTimeTitles) });

    // 2. Reassigned — index 1+ only (index 0 is the creation self-assignment).
    const assignmentEvents = await qr.manager
      .getRepository(CaseAssignmentEventEntity)
      .find({ where: { tenantId, caseId: kase.id }, order: { at: "ASC" } });
    for (const ev of assignmentEvents.slice(1)) {
      events.push({
        type: "reassigned",
        at: ev.at.toISOString(),
        actor: ev.assignedBy,
        text: ev.assignedTo ? `Reassigned this case to ${ev.assignedTo}.` : "Unassigned this case.",
      });
    }

    // 3. Note added
    const notes = await this.casesService.listNotes(qr, tenantId, kase.id);
    for (const note of notes) {
      events.push({ type: "note", at: note.createdAt, actor: note.userId, text: note.content });
    }

    // 4. Evidence uploaded — Section 2.6's fix (the mock omits this entirely).
    const evidence = await this.casesService.listEvidence(qr, tenantId, kase.id);
    for (const e of evidence) {
      events.push({ type: "evidence", at: e.createdAt, actor: e.uploadedBy, text: `Uploaded evidence: "${e.fileName}".` });
    }

    // 5. Alert linked — case_alert rows linked strictly AFTER creation only.
    for (const ca of caseAlerts) {
      if (ca.linkedAt.getTime() <= kase.createdAt.getTime()) continue;
      const alert = alertById.get(ca.alertId);
      events.push({
        type: "alert_linked",
        at: ca.linkedAt.toISOString(),
        actor: ca.linkedBy,
        text: `Linked alert "${alert?.title ?? ca.alertId}" to this case.`,
      });
    }

    // 6. Transaction — actor is always the literal "system", never a user.
    const transactions = await this.casesService.getDerivedTransactions(qr, tenantId, kase.id);
    for (const t of transactions) {
      events.push({
        type: "transaction",
        at: t.occurredAt,
        actor: "system",
        text: `${humanizeEnum(t.type)} transaction — ${t.narration ?? "No narration"}, ${formatNGN(t.amount)} via ${humanizeEnum(t.channel)}.`,
      });
    }

    // 7. Submitted for approval
    if (kase.submittedAt && kase.submittedBy) {
      events.push({
        type: "submitted",
        at: kase.submittedAt.toISOString(),
        actor: kase.submittedBy,
        text: "Submitted this case for SAR-escalation approval.",
      });
    }

    // 8. Approved / Rejected
    const approvalEvents = await qr.manager
      .getRepository(CaseApprovalEventEntity)
      .find({ where: { tenantId, caseId: kase.id }, order: { at: "ASC" } });
    for (const ev of approvalEvents) {
      events.push({
        type: ev.outcome === CaseApprovalOutcome.APPROVED ? "approved" : "rejected",
        at: ev.at.toISOString(),
        actor: ev.actor,
        text:
          ev.outcome === CaseApprovalOutcome.APPROVED
            ? "Approved this case's SAR escalation request."
            : `Rejected this case's SAR escalation request. ${ev.reason ?? ""}`.trim(),
      });
    }

    // 9. Terminal event — mutually exclusive: a case is either CLOSED (direct close path,
    // closed_at set but status CLOSED) or SAR_FILED (approval path, closed_at ALSO set —
    // Section 6's schema table — but status is SAR_FILED, not CLOSED).
    if (kase.closedAt && kase.status === CaseStatus.CLOSED) {
      events.push({
        type: "closed",
        at: kase.closedAt.toISOString(),
        actor: kase.closedBy ?? "system",
        text: `Closed this case as a false positive.${kase.closureReason ? ` ${kase.closureReason}` : ""}`,
      });
    } else if (kase.approvedAt && kase.approvedBy) {
      events.push({
        type: "sar_filed",
        at: kase.approvedAt.toISOString(),
        actor: kase.approvedBy,
        text: "Approved and escalated this case for SAR filing.",
      });
    }

    return events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }

  private openedText(creationTimeAlertTitles: string[]): string {
    if (creationTimeAlertTitles.length === 0) return "Opened this case.";
    if (creationTimeAlertTitles.length === 1) return `Opened this case from alert "${creationTimeAlertTitles[0]}".`;
    const titles = creationTimeAlertTitles.map((t) => `"${t}"`).join(", ");
    return `Opened this case, linked to ${creationTimeAlertTitles.length} alerts: ${titles}.`;
  }
}

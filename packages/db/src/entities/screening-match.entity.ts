import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { MatchDecision, MatchReviewStatus } from "@regops/shared";

/**
 * Individual matches within a check — one check can produce multiple
 * matches (Section 3.3). Created for any match at/above the tenant's
 * potential-match threshold (score >= 60 by default), regardless of whether
 * it further crosses into CONFIRMED_MATCH — even an automated,
 * high-confidence hit still gets a row here for the human review trail.
 *
 * customer_id is nullable, deviating from the spec's literal (unannotated,
 * so presumptively NOT NULL) schema: the synchronous sanctions pre-screen at
 * onboarding (Section 5.1) runs BEFORE the Customer row exists, and Section
 * 10.3's own test requires a ScreeningMatch row to exist for that exact
 * blocked-onboarding scenario ("ScreeningMatch row exists, review_status
 * PENDING_REVIEW") — where there is, by construction, no customer to
 * reference yet. Matches screening_check.customer_id's already-nullable
 * treatment for the identical reason.
 */
@Entity({ name: "screening_match" })
export class ScreeningMatchEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "screening_check_id", type: "uuid" })
  @Index()
  screeningCheckId!: string;

  @Column({ name: "customer_id", type: "uuid", nullable: true })
  @Index()
  customerId!: string | null;

  /** 'OFAC_SDN', 'UN_CONSOLIDATED', 'INTERNAL_BLACKLIST', etc. — a free-form
   * label (not an enum), since real providers return their own list names. */
  @Column({ name: "list_source", type: "varchar", length: 100 })
  listSource!: string;

  @Column({ name: "match_name", type: "varchar", length: 255 })
  matchName!: string;

  @Column({ name: "match_score", type: "smallint" })
  matchScore!: number;

  @Column({ name: "match_data", type: "jsonb" })
  matchData!: Record<string, unknown>;

  @Column({
    name: "review_status",
    type: "enum",
    enum: MatchReviewStatus,
    enumName: "match_review_status_enum",
    default: MatchReviewStatus.PENDING_REVIEW,
  })
  reviewStatus!: MatchReviewStatus;

  @Column({ type: "enum", enum: MatchDecision, enumName: "match_decision_enum", nullable: true })
  decision!: MatchDecision | null;

  @Column({ name: "decision_reason", type: "text", nullable: true })
  decisionReason!: string | null;

  @Column({ name: "reviewed_by", type: "uuid", nullable: true })
  reviewedBy!: string | null;

  @Column({ name: "reviewed_at", type: "timestamptz", nullable: true })
  reviewedAt!: Date | null;

  @Column({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}

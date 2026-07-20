import { IsUUID } from "class-validator";

/** POST /rules/:id/test (Section 9): dry-runs the rule's CURRENT config
 * against an existing transaction, without persisting an Alert or a
 * RuleEvaluation row. */
export class TestRuleDto {
  @IsUUID()
  transactionId!: string;
}

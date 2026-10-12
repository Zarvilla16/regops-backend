import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Password reset / invite acceptance, and the first-login password-change flag.
 *
 *  - "user".must_change_password: set when an admin creates a user with a temporary password; the API
 *    refuses every route except /auth/me, /auth/change-password and /auth/logout until it is cleared.
 *  - password_token: single-use, expiring tokens e-mailed to a user (RESET = forgot password, INVITE =
 *    accept an invitation). Only the SHA-256 of the token is stored. Like refresh_token it has no tenant_id
 *    and no RLS: it is only ever reached through a token the caller already holds, by hash.
 */
export class PasswordTokens1700000070000 implements MigrationInterface {
  name = "PasswordTokens1700000070000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;`);

    await queryRunner.query(`CREATE TYPE password_token_purpose_enum AS ENUM ('RESET', 'INVITE');`);
    await queryRunner.query(`
      CREATE TABLE password_token (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        purpose password_token_purpose_enum NOT NULL,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`CREATE INDEX idx_password_token_user ON password_token (user_id, purpose, created_at DESC);`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS password_token;`);
    await queryRunner.query(`DROP TYPE IF EXISTS password_token_purpose_enum;`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN IF EXISTS must_change_password;`);
  }
}

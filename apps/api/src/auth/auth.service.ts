import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import * as crypto from "crypto";
import { DataSource, QueryRunner } from "typeorm";
import { IsNull, MoreThan } from "typeorm";
import { PasswordTokenEntity, PasswordTokenPurpose, RefreshTokenEntity, TenantEntity, UserEntity } from "@regops/db";
import { AuthUserContext, UserStatus } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { MailService } from "../mail/mail.service";
import { passwordChangedMail, passwordResetMail } from "../mail/mail-templates";
import { MfaService } from "./mfa.service";
import { RequestMeta } from "../users/users.service";
import { RESET_REQUEST_COOLDOWN_MS, RESET_TOKEN_TTL_MS, generatePasswordToken, hashPasswordToken } from "./password-token.util";

const ARGON2_OPTIONS: argon2.Options = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 };

const MAX_FAILED_ATTEMPTS = 5;
const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000;
const MFA_CHALLENGE_TTL = "5m";

const HTTP_STATUS_LOCKED = 423;

class LockedException extends HttpException {
  constructor(response: { code: string; message: string }) {
    super(response, HTTP_STATUS_LOCKED);
  }
}

export interface RefreshPayload {
  sub: string;
  tenantId: string;
  role: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mfaService: MfaService,
    private readonly auditService: AuditService,
    private readonly mailService: MailService,
  ) {}

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  // `set_config(..., true)` only survives for the life of a transaction —
  // outside of one, Postgres discards it as soon as that single statement's
  // implicit transaction ends, so a later query on this same connection
  // would see it unset again. See TenantContextMiddleware for the full
  // explanation of why this must be an explicit transaction rather than
  // session-level (`is_local = false`).
  private async withBypassQueryRunner<T>(fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      const result = await fn(qr);
      await qr.commitTransaction();
      return result;
    } catch (err) {
      if (qr.isTransactionActive) {
        await qr.rollbackTransaction();
      }
      throw err;
    } finally {
      await qr.release();
    }
  }

  private signAccessToken(user: UserEntity): string {
    // `mcp` ("must change password") restricts the token to the routes marked @AllowPasswordChangePending;
    // see PasswordChangeGuard. It is re-derived from the database on every login and refresh.
    const payload: AuthUserContext & { mcp?: boolean } = {
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      email: user.email,
      ...(user.mustChangePassword ? { mcp: true } : {}),
    };
    return this.jwtService.sign(payload, {
      secret: this.configService.get<string>("jwt.accessSecret"),
      expiresIn: this.configService.get<string>("jwt.accessTtl"),
    });
  }

  private signMfaChallengeToken(user: UserEntity): string {
    return this.jwtService.sign(
      { sub: user.id, type: "mfa_challenge" },
      {
        secret: this.configService.get<string>("jwt.accessSecret"),
        expiresIn: MFA_CHALLENGE_TTL,
      },
    );
  }

  private async issueRefreshToken(
    qr: QueryRunner,
    user: UserEntity,
    meta: RequestMeta,
    replacesId?: string,
  ): Promise<string> {
    const refreshTtl = this.configService.get<string>("jwt.refreshTtl") ?? "30d";
    // jti makes each token unique even when issued for the same user within
    // the same second (same iat), which would otherwise sign identically and
    // defeat rotation/reuse-detection (both tokens would hash the same).
    const token = this.jwtService.sign(
      { sub: user.id, tenantId: user.tenantId, role: user.role, jti: crypto.randomUUID() },
      { secret: this.configService.get<string>("jwt.refreshSecret"), expiresIn: refreshTtl },
    );

    const repo = qr.manager.getRepository(RefreshTokenEntity);
    const saved = await repo.save(
      repo.create({
        userId: user.id,
        tokenHash: this.hashToken(token),
        expiresAt: new Date(Date.now() + this.parseTtlMs(refreshTtl)),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      }),
    );

    if (replacesId) {
      await repo.update({ id: replacesId }, { replacedById: saved.id });
    }

    return token;
  }

  private parseTtlMs(ttl: string): number {
    const match = /^(\d+)([smhd])$/.exec(ttl.trim());
    if (!match) return 30 * 24 * 60 * 60 * 1000;
    const value = Number(match[1]);
    const unit = match[2];
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 86_400_000;
    return value * unitMs;
  }

  private toUserDto(user: UserEntity) {
    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private isLocked(user: UserEntity): boolean {
    return Boolean(user.lockedUntil && user.lockedUntil.getTime() > Date.now());
  }

  private async recordFailedAttempt(
    qr: QueryRunner,
    user: UserEntity,
    meta: RequestMeta,
  ): Promise<void> {
    const repo = qr.manager.getRepository(UserEntity);

    // updatedAt doubles as "last activity" here: the schema has no dedicated
    // last-failed-attempt column, so a gap longer than the attempt window
    // since the last update is treated as the start of a fresh window.
    const withinWindow =
      user.updatedAt && Date.now() - user.updatedAt.getTime() < FAILED_ATTEMPT_WINDOW_MS;
    const nextCount = (withinWindow ? user.failedLoginCount : 0) + 1;

    const update: { failedLoginCount: number; lockedUntil?: Date } = {
      failedLoginCount: nextCount,
    };
    if (nextCount >= MAX_FAILED_ATTEMPTS) {
      update.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
      update.failedLoginCount = 0;
    }
    await repo.update({ id: user.id }, update);

    await this.auditService.record(qr, {
      tenantId: user.tenantId,
      userId: user.id,
      action: "user.login.failed",
      entityType: "user",
      entityId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  async login(email: string, password: string, meta: RequestMeta) {
    // Failure branches below record state (a failed-attempt audit row, a
    // lockout) that must survive even though the request ultimately 401s.
    // withBypassQueryRunner rolls back on any thrown error — appropriate for
    // a genuine system failure, wrong for "invalid credentials", which is
    // expected control flow here. So this callback never throws for expected
    // auth failures; it returns a tagged result and login() throws only
    // after withBypassQueryRunner has committed it.
    const result = await this.withBypassQueryRunner(async (qr) => {
      const repo = qr.manager.getRepository(UserEntity);
      const matches = await repo
        .createQueryBuilder("u")
        .where("lower(u.email) = lower(:email)", { email })
        .getMany();

      if (matches.length !== 1) {
        // Zero matches: unknown email. Multiple matches: email collides
        // across tenants, which this phase's email-only login cannot
        // disambiguate (see auth.service.ts login() comment / README).
        return { outcome: "invalid" as const };
      }

      const user = matches[0];

      if (this.isLocked(user)) {
        return { outcome: "locked" as const };
      }

      const passwordValid = await argon2.verify(user.passwordHash, password).catch(() => false);
      if (!passwordValid) {
        await this.recordFailedAttempt(qr, user, meta);
        return { outcome: "invalid" as const };
      }

      await qr.manager
        .getRepository(UserEntity)
        .update({ id: user.id }, { failedLoginCount: 0 });

      // Checked only after the password is proven right, so a suspended account's status isn't
      // disclosed to someone who doesn't know its password.
      if (user.status === UserStatus.SUSPENDED) {
        return { outcome: "suspended" as const };
      }

      if (user.mfaEnabled) {
        return {
          outcome: "mfa" as const,
          data: { mfaRequired: true, mfaToken: this.signMfaChallengeToken(user) },
        };
      }

      return { outcome: "success" as const, data: await this.completeLogin(qr, user, meta) };
    });

    switch (result.outcome) {
      case "invalid":
        throw new UnauthorizedException({
          code: "INVALID_CREDENTIALS",
          message: "Invalid email or password.",
        });
      case "locked":
        throw new LockedException({
          code: "ACCOUNT_LOCKED",
          message: "This account is temporarily locked due to too many failed login attempts.",
        });
      case "suspended":
        throw new ForbiddenException({
          code: "ACCOUNT_SUSPENDED",
          message: "This account has been suspended. Contact your administrator.",
        });
      case "mfa":
      case "success":
        return result.data;
    }
  }

  async verifyMfa(mfaToken: string, code: string, meta: RequestMeta) {
    let payload: { sub: string; type: string };
    try {
      payload = this.jwtService.verify(mfaToken, {
        secret: this.configService.get<string>("jwt.accessSecret"),
      });
    } catch {
      throw new UnauthorizedException({
        code: "INVALID_MFA_TOKEN",
        message: "MFA challenge expired or invalid, please log in again.",
      });
    }
    if (payload.type !== "mfa_challenge") {
      throw new UnauthorizedException({ code: "INVALID_MFA_TOKEN", message: "Invalid token." });
    }

    // Same reasoning as login(): the failed-attempt audit row for an invalid
    // MFA code must survive even though the request 401s, so this callback
    // returns a tagged result instead of throwing (see login() comment).
    const result = await this.withBypassQueryRunner(async (qr) => {
      const user = await qr.manager.getRepository(UserEntity).findOne({
        where: { id: payload.sub },
      });
      if (!user || !user.mfaSecret || user.status === UserStatus.SUSPENDED) {
        return { outcome: "invalid_token" as const };
      }

      const secret = this.mfaService.decryptSecret(user.mfaSecret);
      if (!this.mfaService.verifyCode(secret, code)) {
        await this.auditService.record(qr, {
          tenantId: user.tenantId,
          userId: user.id,
          action: "user.login.failed",
          entityType: "user",
          entityId: user.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        });
        return { outcome: "invalid_code" as const };
      }

      return { outcome: "success" as const, data: await this.completeLogin(qr, user, meta) };
    });

    switch (result.outcome) {
      case "invalid_token":
        throw new UnauthorizedException({ code: "INVALID_MFA_TOKEN", message: "Invalid token." });
      case "invalid_code":
        throw new UnauthorizedException({ code: "INVALID_MFA_CODE", message: "Invalid code." });
      case "success":
        return result.data;
    }
  }

  private async completeLogin(qr: QueryRunner, user: UserEntity, meta: RequestMeta) {
    await qr.manager.getRepository(UserEntity).update({ id: user.id }, { lastLoginAt: new Date() });

    const accessToken = this.signAccessToken(user);
    const refreshToken = await this.issueRefreshToken(qr, user, meta);

    await this.auditService.record(qr, {
      tenantId: user.tenantId,
      userId: user.id,
      action: "user.login.success",
      entityType: "user",
      entityId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      mfaRequired: false,
      accessToken,
      refreshToken,
      user: this.toUserDto(user),
    };
  }

  async refresh(payload: RefreshPayload, meta: RequestMeta) {
    const repo = this.dataSource.getRepository(RefreshTokenEntity);
    const tokenHash = this.hashToken(payload.refreshToken);
    const existing = await repo.findOne({ where: { tokenHash } });

    if (!existing) {
      throw new UnauthorizedException({ code: "INVALID_REFRESH_TOKEN", message: "Invalid refresh token." });
    }

    if (existing.revokedAt) {
      // Reuse of an already-rotated-away token: treat as theft and kill the
      // whole session family for this user.
      await repo
        .createQueryBuilder()
        .update()
        .set({ revokedAt: new Date() })
        .where("user_id = :userId", { userId: existing.userId })
        .andWhere("revoked_at IS NULL")
        .execute();
      this.logger.warn(`Refresh token reuse detected for user ${existing.userId}`);
      throw new UnauthorizedException({
        code: "REFRESH_TOKEN_REUSED",
        message: "This refresh token has already been used. All sessions have been revoked.",
      });
    }

    if (existing.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException({ code: "REFRESH_TOKEN_EXPIRED", message: "Refresh token expired." });
    }

    return this.withBypassQueryRunner(async (qr) => {
      // Looked up here (under bypass_rls, inside withBypassQueryRunner's
      // transaction) rather than via the plain injected repository above:
      // the `user` table has RLS enabled, and a freshly-pooled connection
      // with no tenant/bypass context set would have every row filtered out.
      const user = await qr.manager.getRepository(UserEntity).findOne({ where: { id: existing.userId } });
      if (!user || user.status === UserStatus.SUSPENDED) {
        throw new UnauthorizedException({ code: "INVALID_REFRESH_TOKEN", message: "Invalid refresh token." });
      }

      await qr.manager
        .getRepository(RefreshTokenEntity)
        .update({ id: existing.id }, { revokedAt: new Date() });

      const accessToken = this.signAccessToken(user);
      const refreshToken = await this.issueRefreshToken(qr, user, meta, existing.id);

      return { accessToken, refreshToken };
    });
  }

  private async revokeAllRefreshTokens(qr: QueryRunner, userId: string): Promise<void> {
    await qr.manager
      .getRepository(RefreshTokenEntity)
      .update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  /**
   * Starts a password reset. Always completes the same way whether or not the address belongs to an account
   * (no account enumeration): the caller learns nothing, and the mail is sent in the background so response
   * time doesn't differ either. At most one reset mail per account per RESET_REQUEST_COOLDOWN_MS.
   */
  async forgotPassword(email: string, meta: RequestMeta): Promise<void> {
    const outbound = await this.withBypassQueryRunner(async (qr) => {
      const users = await qr.manager
        .getRepository(UserEntity)
        .createQueryBuilder("u")
        .where("lower(u.email) = lower(:email)", { email })
        .getMany();
      // Same rule as login(): an address shared across tenants can't be resolved to one account.
      if (users.length !== 1) return null;
      const user = users[0];
      if (user.status === UserStatus.SUSPENDED) return null;

      const tokens = qr.manager.getRepository(PasswordTokenEntity);
      const recent = await tokens.findOne({
        where: {
          userId: user.id,
          purpose: PasswordTokenPurpose.RESET,
          createdAt: MoreThan(new Date(Date.now() - RESET_REQUEST_COOLDOWN_MS)),
        },
      });
      if (recent) return null;

      const { token, tokenHash } = generatePasswordToken();
      await tokens.save(
        tokens.create({
          userId: user.id,
          purpose: PasswordTokenPurpose.RESET,
          tokenHash,
          expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        }),
      );
      await this.auditService.record(qr, {
        tenantId: user.tenantId,
        userId: user.id,
        action: "user.password.reset_requested",
        entityType: "user",
        entityId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return { user, token };
    });

    if (outbound) {
      const url = `${this.configService.get<string>("frontendUrl")}/reset-password?token=${encodeURIComponent(outbound.token)}`;
      void this.mailService.send(
        passwordResetMail({
          to: outbound.user.email,
          fullName: outbound.user.fullName,
          url,
          expiresInMinutes: RESET_TOKEN_TTL_MS / 60_000,
        }),
      );
    }
  }

  /**
   * Completes a reset or accepts an invitation: sets the password, clears lockout and the temporary-password
   * flag, activates an INVITED account, burns every outstanding token for the user and signs out all sessions.
   */
  async resetPassword(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const tokenHash = hashPasswordToken(token);
    const result = await this.withBypassQueryRunner(async (qr) => {
      const tokens = qr.manager.getRepository(PasswordTokenEntity);
      const row = await tokens.findOne({ where: { tokenHash } });
      if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return null;

      const users = qr.manager.getRepository(UserEntity);
      const user = await users.findOne({ where: { id: row.userId } });
      if (!user || user.status === UserStatus.SUSPENDED) return null;

      // Single-use even under concurrent requests: only the request that flips used_at wins.
      const claimed = await tokens.update({ id: row.id, usedAt: IsNull() }, { usedAt: new Date() });
      if (claimed.affected !== 1) return null;

      await users.update(
        { id: user.id },
        {
          passwordHash: await argon2.hash(newPassword, ARGON2_OPTIONS),
          mustChangePassword: false,
          failedLoginCount: 0,
          lockedUntil: null,
          status: user.status === UserStatus.INVITED ? UserStatus.ACTIVE : user.status,
        },
      );
      await tokens.update({ userId: user.id, usedAt: IsNull() }, { usedAt: new Date() });
      await this.revokeAllRefreshTokens(qr, user.id);
      await this.auditService.record(qr, {
        tenantId: user.tenantId,
        userId: user.id,
        action: row.purpose === PasswordTokenPurpose.INVITE ? "user.invite.accepted" : "user.password.reset",
        entityType: "user",
        entityId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return { user, purpose: row.purpose };
    });

    if (!result) {
      throw new BadRequestException({
        code: "INVALID_OR_EXPIRED_TOKEN",
        message: "This link is invalid or has expired. Request a new one.",
      });
    }
    if (result.purpose === PasswordTokenPurpose.RESET) {
      void this.mailService.send(passwordChangedMail({ to: result.user.email, fullName: result.user.fullName }));
    }
  }

  /**
   * Authenticated password change (also the way out of the temporary-password state). A wrong current
   * password counts as a failed login attempt, so this can't be used to guess it. Every session is signed
   * out and a fresh token pair is returned for the caller to keep working with.
   */
  async changePassword(currentUser: AuthUserContext, currentPassword: string, newPassword: string, meta: RequestMeta) {
    const result = await this.withBypassQueryRunner(async (qr) => {
      const users = qr.manager.getRepository(UserEntity);
      const user = await users.findOne({ where: { id: currentUser.sub } });
      if (!user || user.status === UserStatus.SUSPENDED) return { outcome: "invalid" as const };
      if (this.isLocked(user)) return { outcome: "locked" as const };

      if (!(await argon2.verify(user.passwordHash, currentPassword).catch(() => false))) {
        await this.recordFailedAttempt(qr, user, meta);
        return { outcome: "wrong_password" as const };
      }
      if (await argon2.verify(user.passwordHash, newPassword).catch(() => false)) {
        return { outcome: "same_password" as const };
      }

      user.passwordHash = await argon2.hash(newPassword, ARGON2_OPTIONS);
      user.mustChangePassword = false;
      user.failedLoginCount = 0;
      if (user.status === UserStatus.INVITED) user.status = UserStatus.ACTIVE;
      await users.update(
        { id: user.id },
        { passwordHash: user.passwordHash, mustChangePassword: false, failedLoginCount: 0, status: user.status },
      );
      await this.revokeAllRefreshTokens(qr, user.id);
      const accessToken = this.signAccessToken(user);
      const refreshToken = await this.issueRefreshToken(qr, user, meta);
      await this.auditService.record(qr, {
        tenantId: user.tenantId,
        userId: user.id,
        action: "user.password.change",
        entityType: "user",
        entityId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return { outcome: "success" as const, user, accessToken, refreshToken };
    });

    switch (result.outcome) {
      case "invalid":
        throw new UnauthorizedException({ code: "USER_NOT_FOUND", message: "User not found." });
      case "locked":
        throw new LockedException({
          code: "ACCOUNT_LOCKED",
          message: "This account is temporarily locked due to too many failed attempts.",
        });
      case "wrong_password":
        throw new UnauthorizedException({ code: "INVALID_CURRENT_PASSWORD", message: "Your current password is incorrect." });
      case "same_password":
        throw new BadRequestException({
          code: "PASSWORD_UNCHANGED",
          message: "Your new password must be different from your current password.",
        });
      case "success":
        void this.mailService.send(passwordChangedMail({ to: result.user.email, fullName: result.user.fullName }));
        return { accessToken: result.accessToken, refreshToken: result.refreshToken, user: this.toUserDto(result.user) };
    }
  }

  async logout(refreshToken: string): Promise<void> {
    const repo = this.dataSource.getRepository(RefreshTokenEntity);
    const tokenHash = this.hashToken(refreshToken);
    await repo
      .createQueryBuilder()
      .update()
      .set({ revokedAt: new Date() })
      .where("token_hash = :tokenHash", { tokenHash })
      .andWhere("revoked_at IS NULL")
      .execute();
  }

  /**
   * `tenant` is the tenant the request is scoped to — the user's own, or, for a Super Admin sending
   * X-Tenant-Override, the one they are acting as (`isActingAsTenant`). `user` is always the real caller.
   */
  async me(currentUser: AuthUserContext, queryRunner: QueryRunner, effectiveTenantId: string = currentUser.tenantId) {
    const user = await queryRunner.manager
      .getRepository(UserEntity)
      .findOne({ where: { id: currentUser.sub, tenantId: currentUser.tenantId } });
    if (!user) {
      throw new UnauthorizedException({ code: "USER_NOT_FOUND", message: "User not found." });
    }

    const tenant = await queryRunner.manager
      .getRepository(TenantEntity)
      .findOne({ where: { id: effectiveTenantId } });

    return {
      user: this.toUserDto(user),
      tenant: tenant ? { id: tenant.id, name: tenant.name } : null,
      isActingAsTenant: effectiveTenantId !== user.tenantId,
    };
  }

  async mfaSetup(currentUser: AuthUserContext, queryRunner: QueryRunner) {
    const repo = queryRunner.manager.getRepository(UserEntity);
    const user = await repo.findOne({ where: { id: currentUser.sub, tenantId: currentUser.tenantId } });
    if (!user) {
      throw new UnauthorizedException({ code: "USER_NOT_FOUND", message: "User not found." });
    }

    const secret = this.mfaService.generateSecret();
    await repo.update({ id: user.id }, { mfaSecret: this.mfaService.encryptSecret(secret) });

    const qrCodeDataUrl = await this.mfaService.generateQrCode(user.email, secret);
    return { secret, qrCodeDataUrl };
  }

  async mfaEnable(currentUser: AuthUserContext, queryRunner: QueryRunner, code: string, meta: RequestMeta) {
    const repo = queryRunner.manager.getRepository(UserEntity);
    const user = await repo.findOne({ where: { id: currentUser.sub, tenantId: currentUser.tenantId } });
    if (!user?.mfaSecret) {
      throw new ConflictException({
        code: "MFA_SETUP_REQUIRED",
        message: "Call POST /auth/mfa/setup before enabling MFA.",
      });
    }

    const secret = this.mfaService.decryptSecret(user.mfaSecret);
    if (!this.mfaService.verifyCode(secret, code)) {
      throw new UnauthorizedException({ code: "INVALID_MFA_CODE", message: "Invalid code." });
    }

    await repo.update({ id: user.id }, { mfaEnabled: true });
    await this.auditService.record(queryRunner, {
      tenantId: user.tenantId,
      userId: user.id,
      action: "user.mfa.enabled",
      entityType: "user",
      entityId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { mfaEnabled: true };
  }

  async mfaDisable(currentUser: AuthUserContext, queryRunner: QueryRunner, code: string, meta: RequestMeta) {
    const repo = queryRunner.manager.getRepository(UserEntity);
    const user = await repo.findOne({ where: { id: currentUser.sub, tenantId: currentUser.tenantId } });
    if (!user?.mfaEnabled || !user.mfaSecret) {
      throw new ConflictException({ code: "MFA_NOT_ENABLED", message: "MFA is not enabled." });
    }

    const secret = this.mfaService.decryptSecret(user.mfaSecret);
    if (!this.mfaService.verifyCode(secret, code)) {
      throw new UnauthorizedException({ code: "INVALID_MFA_CODE", message: "Invalid code." });
    }

    await repo.update({ id: user.id }, { mfaEnabled: false, mfaSecret: null });
    await this.auditService.record(queryRunner, {
      tenantId: user.tenantId,
      userId: user.id,
      action: "user.mfa.disabled",
      entityType: "user",
      entityId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { mfaEnabled: false };
  }
}

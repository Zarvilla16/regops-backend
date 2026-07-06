import {
  ConflictException,
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
import { RefreshTokenEntity, TenantEntity, UserEntity } from "@regops/db";
import { AuthUserContext } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { MfaService } from "./mfa.service";
import { RequestMeta } from "../users/users.service";

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
  ) {}

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private async withBypassQueryRunner<T>(fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      return await fn(qr);
    } finally {
      await qr.release();
    }
  }

  private signAccessToken(user: UserEntity): string {
    const payload: AuthUserContext = {
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      email: user.email,
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
    const token = this.jwtService.sign(
      { sub: user.id, tenantId: user.tenantId, role: user.role },
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
    return this.withBypassQueryRunner(async (qr) => {
      const repo = qr.manager.getRepository(UserEntity);
      const matches = await repo
        .createQueryBuilder("u")
        .where("lower(u.email) = lower(:email)", { email })
        .getMany();

      if (matches.length !== 1) {
        // Zero matches: unknown email. Multiple matches: email collides
        // across tenants, which this phase's email-only login cannot
        // disambiguate (see auth.service.ts login() comment / README).
        throw new UnauthorizedException({
          code: "INVALID_CREDENTIALS",
          message: "Invalid email or password.",
        });
      }

      const user = matches[0];

      if (this.isLocked(user)) {
        throw new LockedException({
          code: "ACCOUNT_LOCKED",
          message: "This account is temporarily locked due to too many failed login attempts.",
        });
      }

      const passwordValid = await argon2.verify(user.passwordHash, password).catch(() => false);
      if (!passwordValid) {
        await this.recordFailedAttempt(qr, user, meta);
        throw new UnauthorizedException({
          code: "INVALID_CREDENTIALS",
          message: "Invalid email or password.",
        });
      }

      await qr.manager
        .getRepository(UserEntity)
        .update({ id: user.id }, { failedLoginCount: 0 });

      if (user.mfaEnabled) {
        return { mfaRequired: true, mfaToken: this.signMfaChallengeToken(user) };
      }

      return this.completeLogin(qr, user, meta);
    });
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

    return this.withBypassQueryRunner(async (qr) => {
      const user = await qr.manager.getRepository(UserEntity).findOne({
        where: { id: payload.sub },
      });
      if (!user || !user.mfaSecret) {
        throw new UnauthorizedException({ code: "INVALID_MFA_TOKEN", message: "Invalid token." });
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
        throw new UnauthorizedException({ code: "INVALID_MFA_CODE", message: "Invalid code." });
      }

      return this.completeLogin(qr, user, meta);
    });
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

    const user = await this.dataSource
      .getRepository(UserEntity)
      .findOne({ where: { id: existing.userId } });
    if (!user) {
      throw new UnauthorizedException({ code: "INVALID_REFRESH_TOKEN", message: "Invalid refresh token." });
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      await qr.manager
        .getRepository(RefreshTokenEntity)
        .update({ id: existing.id }, { revokedAt: new Date() });

      const accessToken = this.signAccessToken(user);
      const refreshToken = await this.issueRefreshToken(qr, user, meta, existing.id);

      return { accessToken, refreshToken };
    } finally {
      await qr.release();
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

  async me(currentUser: AuthUserContext, queryRunner: QueryRunner) {
    const user = await queryRunner.manager
      .getRepository(UserEntity)
      .findOne({ where: { id: currentUser.sub, tenantId: currentUser.tenantId } });
    if (!user) {
      throw new UnauthorizedException({ code: "USER_NOT_FOUND", message: "User not found." });
    }

    const tenant = await queryRunner.manager
      .getRepository(TenantEntity)
      .findOne({ where: { id: user.tenantId } });

    return { user: this.toUserDto(user), tenant: tenant ? { id: tenant.id, name: tenant.name } : null };
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

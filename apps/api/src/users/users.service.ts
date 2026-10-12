import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as argon2 from "argon2";
import * as crypto from "crypto";
import { IsNull, QueryRunner } from "typeorm";
import { PasswordTokenEntity, PasswordTokenPurpose, RefreshTokenEntity, TenantEntity, UserEntity } from "@regops/db";
import { AuthUserContext, UserRole, UserStatus } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { INVITE_TOKEN_TTL_MS, generatePasswordToken } from "../auth/password-token.util";
import { MailService } from "../mail/mail.service";
import { inviteMail } from "../mail/mail-templates";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";

/** Which roles an actor may hand out. Only a Super Admin can mint another Super Admin. */
const ASSIGNABLE_ROLES: Record<UserRole, UserRole[]> = {
  [UserRole.SUPER_ADMIN]: Object.values(UserRole),
  [UserRole.TENANT_ADMIN]: [UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER, UserRole.INVESTIGATOR, UserRole.VIEWER],
  [UserRole.COMPLIANCE_OFFICER]: [],
  [UserRole.INVESTIGATOR]: [],
  [UserRole.VIEWER]: [],
};

function assertCanAssignRole(actorRole: UserRole, targetRole: UserRole): void {
  if (!ASSIGNABLE_ROLES[actorRole]?.includes(targetRole)) {
    throw new ForbiddenException({
      code: "ROLE_NOT_ASSIGNABLE",
      message: `Your role cannot grant the ${targetRole} role.`,
    });
  }
}

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
};

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly auditService: AuditService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {}

  toDto(user: UserEntity) {
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

  async findAllForTenant(queryRunner: QueryRunner, tenantId: string): Promise<UserEntity[]> {
    return queryRunner.manager.getRepository(UserEntity).find({ where: { tenantId } });
  }

  /** Returns null (never throws) so callers can 404 without leaking whether the id exists in another tenant. */
  async findOneForTenant(
    queryRunner: QueryRunner,
    tenantId: string,
    id: string,
  ): Promise<UserEntity | null> {
    return queryRunner.manager.getRepository(UserEntity).findOne({ where: { tenantId, id } });
  }

  async create(
    queryRunner: QueryRunner,
    tenantId: string,
    dto: CreateUserDto,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ) {
    assertCanAssignRole(currentUser.role as UserRole, dto.role);

    const repo = queryRunner.manager.getRepository(UserEntity);
    // Emails are unique across the whole platform, not just per tenant: login identifies an account by email
    // alone, so a second account with the same address would make both unable to sign in.
    const existing = await repo
      .createQueryBuilder("u")
      .withDeleted()
      .where("lower(u.email) = lower(:email)", { email: dto.email })
      .getOne();

    if (existing) {
      throw new ConflictException({
        code: "USER_EMAIL_TAKEN",
        message: "A user with this email already exists.",
      });
    }

    // No password supplied = invitation: the user chooses their own through the e-mailed link, and until then
    // the stored hash is of a random secret nobody knows. A password supplied by the admin is a temporary one
    // that the user is forced to change on first sign-in.
    const isInvitation = !dto.password;
    await queryRunner.startTransaction();
    try {
      const passwordHash = await argon2.hash(dto.password ?? crypto.randomBytes(32).toString("hex"), ARGON2_OPTIONS);
      const user = await repo.save(
        repo.create({
          tenantId,
          email: dto.email,
          passwordHash,
          fullName: dto.fullName,
          role: dto.role,
          status: UserStatus.INVITED,
          mustChangePassword: !isInvitation,
        }),
      );

      const inviteToken = isInvitation ? await this.issueInviteToken(queryRunner, user.id) : null;

      await this.auditService.record(queryRunner, {
        tenantId,
        userId: currentUser.sub,
        action: isInvitation ? "user.invite" : "user.create",
        entityType: "user",
        entityId: user.id,
        afterState: { ...user },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await queryRunner.commitTransaction();
      if (inviteToken) await this.sendInvite(queryRunner, user, tenantId, currentUser, inviteToken);
      return this.toDto(user);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    }
  }

  /** Re-sends the invitation to a user who has not accepted it yet; older invite links stop working. */
  async resendInvite(
    queryRunner: QueryRunner,
    tenantId: string,
    id: string,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ) {
    const user = await queryRunner.manager.getRepository(UserEntity).findOne({ where: { tenantId, id } });
    if (!user) {
      throw new NotFoundException({ code: "USER_NOT_FOUND", message: "User not found." });
    }
    if (user.status !== UserStatus.INVITED || user.mustChangePassword) {
      throw new BadRequestException({
        code: "NOT_AWAITING_INVITE",
        message: "Only a user who was invited by e-mail and has not accepted yet can be re-invited.",
      });
    }

    await queryRunner.startTransaction();
    try {
      await queryRunner.manager
        .getRepository(PasswordTokenEntity)
        .update({ userId: user.id, purpose: PasswordTokenPurpose.INVITE, usedAt: IsNull() }, { usedAt: new Date() });
      const inviteToken = await this.issueInviteToken(queryRunner, user.id);
      await this.auditService.record(queryRunner, {
        tenantId,
        userId: currentUser.sub,
        action: "user.invite.resend",
        entityType: "user",
        entityId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      await queryRunner.commitTransaction();
      await this.sendInvite(queryRunner, user, tenantId, currentUser, inviteToken);
      return { sent: this.mailService.isConfigured() };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    }
  }

  private async issueInviteToken(queryRunner: QueryRunner, userId: string): Promise<string> {
    const { token, tokenHash } = generatePasswordToken();
    const repo = queryRunner.manager.getRepository(PasswordTokenEntity);
    await repo.save(
      repo.create({
        userId,
        purpose: PasswordTokenPurpose.INVITE,
        tokenHash,
        expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
      }),
    );
    return token;
  }

  private async sendInvite(
    queryRunner: QueryRunner,
    user: UserEntity,
    tenantId: string,
    currentUser: AuthUserContext,
    token: string,
  ): Promise<void> {
    const [tenant, inviter] = await Promise.all([
      queryRunner.manager.getRepository(TenantEntity).findOne({ where: { id: tenantId } }),
      queryRunner.manager.getRepository(UserEntity).findOne({ where: { id: currentUser.sub } }),
    ]);
    const url = `${this.configService.get<string>("frontendUrl")}/reset-password?token=${encodeURIComponent(token)}&invite=1`;
    void this.mailService.send(
      inviteMail({
        to: user.email,
        fullName: user.fullName,
        inviterName: inviter?.fullName ?? currentUser.email,
        tenantName: tenant?.name ?? "your organisation",
        url,
        expiresInDays: INVITE_TOKEN_TTL_MS / 86_400_000,
      }),
    );
  }

  async update(
    queryRunner: QueryRunner,
    tenantId: string,
    id: string,
    dto: UpdateUserDto,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ) {
    const repo = queryRunner.manager.getRepository(UserEntity);
    const user = await repo.findOne({ where: { tenantId, id } });
    if (!user) {
      throw new NotFoundException({ code: "USER_NOT_FOUND", message: "User not found." });
    }

    // Nobody can change their own role or status (no self-promotion, no locking yourself out by accident),
    // and only a Super Admin may touch a Super Admin account or grant that role.
    const isSelf = user.id === currentUser.sub;
    if (isSelf && (dto.role !== undefined || dto.status !== undefined)) {
      throw new ForbiddenException({
        code: "CANNOT_CHANGE_OWN_ACCESS",
        message: "You cannot change your own role or status.",
      });
    }
    if (user.role === UserRole.SUPER_ADMIN && currentUser.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException({ code: "FORBIDDEN_ROLE", message: "Only a Super Admin can modify a Super Admin." });
    }
    if (dto.role !== undefined) assertCanAssignRole(currentUser.role as UserRole, dto.role);

    const before = { ...user };

    await queryRunner.startTransaction();
    try {
      Object.assign(user, dto);
      const saved = await repo.save(user);

      // A suspended user is signed out everywhere immediately, not when their tokens eventually expire.
      if (dto.status === UserStatus.SUSPENDED) {
        await queryRunner.manager
          .getRepository(RefreshTokenEntity)
          .update({ userId: saved.id, revokedAt: IsNull() }, { revokedAt: new Date() });
      }

      await this.auditService.record(queryRunner, {
        tenantId,
        userId: currentUser.sub,
        action: "user.update",
        entityType: "user",
        entityId: saved.id,
        beforeState: before,
        afterState: { ...saved },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await queryRunner.commitTransaction();
      return this.toDto(saved);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    }
  }
}

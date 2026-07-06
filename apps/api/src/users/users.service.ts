import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import * as argon2 from "argon2";
import { QueryRunner } from "typeorm";
import { UserEntity } from "@regops/db";
import { AuthUserContext, UserStatus } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";

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
  constructor(private readonly auditService: AuditService) {}

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
    const repo = queryRunner.manager.getRepository(UserEntity);
    const existing = await repo
      .createQueryBuilder("u")
      .where("u.tenant_id = :tenantId", { tenantId })
      .andWhere("lower(u.email) = lower(:email)", { email: dto.email })
      .getOne();

    if (existing) {
      throw new ConflictException({
        code: "USER_EMAIL_TAKEN",
        message: "A user with this email already exists in this tenant.",
      });
    }

    await queryRunner.startTransaction();
    try {
      const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);
      const user = await repo.save(
        repo.create({
          tenantId,
          email: dto.email,
          passwordHash,
          fullName: dto.fullName,
          role: dto.role,
          status: UserStatus.INVITED,
        }),
      );

      await this.auditService.record(queryRunner, {
        tenantId,
        userId: currentUser.sub,
        action: "user.create",
        entityType: "user",
        entityId: user.id,
        afterState: { ...user },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await queryRunner.commitTransaction();
      return this.toDto(user);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    }
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

    const before = { ...user };

    await queryRunner.startTransaction();
    try {
      Object.assign(user, dto);
      const saved = await repo.save(user);

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

import { ConflictException, Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { CustomerAccountEntity } from "@regops/db";
import { AccountType, CustomerAccountDto } from "@regops/shared";

@Injectable()
export class CustomerAccountsService {
  toDto(account: CustomerAccountEntity): CustomerAccountDto {
    return {
      id: account.id,
      tenantId: account.tenantId,
      customerId: account.customerId,
      accountNumber: account.accountNumber,
      accountType: account.accountType,
      accountName: account.accountName,
      status: account.status,
      balance: account.balance,
      balanceAsOf: account.balanceAsOf ? account.balanceAsOf.toISOString() : null,
      openedAt: account.openedAt ? account.openedAt.toISOString() : null,
      createdAt: account.createdAt.toISOString(),
      updatedAt: account.updatedAt.toISOString(),
    };
  }

  async create(
    queryRunner: QueryRunner,
    tenantId: string,
    params: { customerId: string; accountNumber: string; accountType?: AccountType; accountName?: string },
  ): Promise<CustomerAccountEntity> {
    const repo = queryRunner.manager.getRepository(CustomerAccountEntity);
    const existing = await repo.findOne({ where: { tenantId, accountNumber: params.accountNumber } });
    if (existing) {
      throw new ConflictException({
        code: "ACCOUNT_NUMBER_ALREADY_EXISTS",
        message: "This account number is already mapped to a customer.",
      });
    }

    return repo.save(
      repo.create({
        tenantId,
        customerId: params.customerId,
        accountNumber: params.accountNumber,
        accountType: params.accountType ?? AccountType.SAVINGS,
        accountName: params.accountName ?? null,
      }),
    );
  }

  /** Lazily creates a CustomerAccount the first time a transaction references
   * an account_number this tenant hasn't seen for the resolved customer yet
   * (spec Section 5.7) — never rejects a transaction for a missing account. */
  async findOrCreate(
    queryRunner: QueryRunner,
    tenantId: string,
    customerId: string,
    accountNumber: string,
  ): Promise<CustomerAccountEntity> {
    const repo = queryRunner.manager.getRepository(CustomerAccountEntity);
    const existing = await repo.findOne({ where: { tenantId, accountNumber } });
    if (existing) return existing;

    return repo.save(
      repo.create({
        tenantId,
        customerId,
        accountNumber,
        accountType: AccountType.SAVINGS,
      }),
    );
  }

  async findByCustomer(queryRunner: QueryRunner, tenantId: string, customerId?: string): Promise<CustomerAccountEntity[]> {
    return queryRunner.manager
      .getRepository(CustomerAccountEntity)
      .find({ where: customerId ? { tenantId, customerId } : { tenantId }, order: { createdAt: "DESC" } });
  }
}

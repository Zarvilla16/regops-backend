import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { JwtModule } from "@nestjs/jwt";
import { ScheduleModule } from "@nestjs/schedule";
import { TypeOrmModule } from "@nestjs/typeorm";
import { entities } from "@regops/db";
import configuration from "./config/configuration";
import { validateEnv } from "./config/env.validation";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { AuditInterceptor } from "./common/interceptors/audit.interceptor";
import { IdempotencyInterceptor } from "./common/interceptors/idempotency.interceptor";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
import { TransactionInterceptor } from "./common/interceptors/transaction.interceptor";
import { TenantContextMiddleware } from "./common/middleware/tenant-context.middleware";
import { AuthModule } from "./auth/auth.module";
import { TenantsModule } from "./tenants/tenants.module";
import { UsersModule } from "./users/users.module";
import { AuditModule } from "./audit/audit.module";
import { RiskModule } from "./risk/risk.module";
import { CustomersModule } from "./customers/customers.module";
import { ScreeningModule } from "./screening/screening.module";
import { TransactionsModule } from "./transactions/transactions.module";
import { RulesModule } from "./rules/rules.module";
import { CasesModule } from "./cases/cases.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres",
        // Connects as regops_app (NO BYPASSRLS) so Postgres RLS is enforced
        // for every query the running API issues.
        url: config.get<string>("database.url"),
        entities,
        synchronize: false,
        migrationsRun: false,
        logging: config.get<string>("nodeEnv") === "development" ? ["error", "warn"] : ["error"],
      }),
    }),
    JwtModule.register({}),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    AuditModule,
    AuthModule,
    TenantsModule,
    UsersModule,
    RiskModule,
    CustomersModule,
    ScreeningModule,
    TransactionsModule,
    RulesModule,
    CasesModule,
  ],
  providers: [
    TenantContextMiddleware,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Order matters: Transaction is outermost so it commits/rolls back the
    // request's connection (see TenantContextMiddleware) only after every
    // other interceptor has finished using it — a client must never see a
    // success response for a write that hasn't actually committed. Response
    // wraps the client-facing shape, Idempotency may short-circuit before
    // the handler/Audit ever run, Audit is innermost so it observes the
    // handler's real result.
    { provide: APP_INTERCEPTOR, useClass: TransactionInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes("*");
  }
}

import { Module } from "@nestjs/common";
import { MockProvider, PremblyProvider, SmileIdProvider } from "@regops/screening-engine";
import { AuditModule } from "../audit/audit.module";
import { RiskModule } from "../risk/risk.module";
import { ScreeningService } from "./screening.service";
import { ScreeningController } from "./screening.controller";
import { MatchReviewController } from "./match-review.controller";
import { MatchReviewService } from "./match-review.service";
import { ProviderRegistry } from "./providers/provider.registry";
import { ScreeningProviderConfigService } from "./providers/screening-provider-config.service";
import { InternalBlacklistProvider } from "./providers/internal-blacklist.provider";
import { SecretsService } from "./secrets.service";
import { AsyncScreeningQueueService } from "./async-screening-queue.service";
import { RescreenQueueService } from "./rescreen-queue.service";
import { RescreenSchedulerService } from "./scheduler/rescreen-scheduler.service";
import { CustomerListener } from "./listeners/customer.listener";

@Module({
  imports: [AuditModule, RiskModule],
  controllers: [ScreeningController, MatchReviewController],
  providers: [
    ScreeningService,
    MatchReviewService,
    ProviderRegistry,
    ScreeningProviderConfigService,
    InternalBlacklistProvider,
    SecretsService,
    SmileIdProvider,
    PremblyProvider,
    MockProvider,
    AsyncScreeningQueueService,
    RescreenQueueService,
    RescreenSchedulerService,
    CustomerListener,
  ],
  exports: [ScreeningService, ScreeningProviderConfigService],
})
export class ScreeningModule {}

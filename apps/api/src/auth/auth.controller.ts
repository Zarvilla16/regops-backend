import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { QueryRunner } from "typeorm";
import { AuthUserContext } from "@regops/shared";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthService, RefreshPayload } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { MfaCodeDto } from "./dto/mfa-code.dto";
import { RefreshDto } from "./dto/refresh.dto";
import { VerifyMfaDto } from "./dto/verify-mfa.dto";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { JwtRefreshGuard } from "./guards/jwt-refresh.guard";
import { TenantGuard } from "./guards/tenant.guard";

function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.header("user-agent") ?? null };
}

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto.email, dto.password, requestMeta(req));
  }

  @Post("verify-mfa")
  @HttpCode(HttpStatus.OK)
  async verifyMfa(@Body() dto: VerifyMfaDto, @Req() req: Request) {
    return this.authService.verifyMfa(dto.mfaToken, dto.code, requestMeta(req));
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtRefreshGuard)
  async refresh(@Req() req: Request, @Body() _dto: RefreshDto) {
    const payload = req.user as unknown as RefreshPayload;
    return this.authService.refresh(payload, requestMeta(req));
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: RefreshDto) {
    await this.authService.logout(dto.refreshToken);
  }

  @Get("me")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, TenantGuard)
  async me(
    @CurrentUser() currentUser: AuthUserContext,
    @CurrentTenant() effectiveTenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
  ) {
    return this.authService.me(currentUser, qr, effectiveTenantId);
  }

  @Post("mfa/setup")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, TenantGuard)
  async mfaSetup(@CurrentUser() currentUser: AuthUserContext, @CurrentQueryRunner() qr: QueryRunner) {
    return this.authService.mfaSetup(currentUser, qr);
  }

  @Post("mfa/enable")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, TenantGuard)
  async mfaEnable(
    @CurrentUser() currentUser: AuthUserContext,
    @CurrentQueryRunner() qr: QueryRunner,
    @Body() dto: MfaCodeDto,
    @Req() req: Request,
  ) {
    return this.authService.mfaEnable(currentUser, qr, dto.code, requestMeta(req));
  }

  @Post("mfa/disable")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, TenantGuard)
  async mfaDisable(
    @CurrentUser() currentUser: AuthUserContext,
    @CurrentQueryRunner() qr: QueryRunner,
    @Body() dto: MfaCodeDto,
    @Req() req: Request,
  ) {
    return this.authService.mfaDisable(currentUser, qr, dto.code, requestMeta(req));
  }
}

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { QueryRunner } from "typeorm";
import { AuthUserContext } from "@regops/shared";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AllowPasswordChangePending } from "../common/decorators/allow-password-change-pending.decorator";
import { AuthService, RefreshPayload } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { MfaCodeDto } from "./dto/mfa-code.dto";
import { ChangePasswordDto, ForgotPasswordDto, ResetPasswordDto } from "./dto/password.dto";
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

  /** Always 202, whether or not the address has an account (no enumeration). */
  @Post("forgot-password")
  @HttpCode(HttpStatus.ACCEPTED)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.authService.forgotPassword(dto.email, requestMeta(req));
    return { message: "If an account exists for that address, a reset link has been sent." };
  }

  /** Completes a password reset, or accepts an invitation, using the token from the e-mailed link. */
  @Post("reset-password")
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.authService.resetPassword(dto.token, dto.newPassword, requestMeta(req));
  }

  @Post("change-password")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @AllowPasswordChangePending()
  async changePassword(@CurrentUser() currentUser: AuthUserContext, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    return this.authService.changePassword(currentUser, dto.currentPassword, dto.newPassword, requestMeta(req));
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @AllowPasswordChangePending()
  @UseGuards(JwtRefreshGuard)
  async refresh(@Req() req: Request, @Body() _dto: RefreshDto) {
    const payload = req.user as unknown as RefreshPayload;
    return this.authService.refresh(payload, requestMeta(req));
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @AllowPasswordChangePending()
  async logout(@Body() dto: RefreshDto) {
    await this.authService.logout(dto.refreshToken);
  }

  @Get("me")
  @AllowPasswordChangePending()
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

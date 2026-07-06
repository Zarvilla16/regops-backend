import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { Strategy } from "passport-jwt";

export interface RefreshTokenPayload {
  sub: string;
  tenantId: string;
  role: string;
}

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, "jwt-refresh") {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: (req: Request) => req.body?.refreshToken ?? null,
      ignoreExpiration: false,
      secretOrKey: configService.get<string>("jwt.refreshSecret"),
      passReqToCallback: true,
    });
  }

  validate(req: Request, payload: RefreshTokenPayload) {
    return { ...payload, refreshToken: req.body?.refreshToken as string };
  }
}

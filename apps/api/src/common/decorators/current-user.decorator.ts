import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { AuthUserContext } from "@regops/shared";

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUserContext => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthUserContext;
  },
);

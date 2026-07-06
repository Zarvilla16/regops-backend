import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole, AuthUserContext } from "@regops/shared";
import { ROLES_KEY } from "../../common/decorators/roles.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthUserContext | undefined;

    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException({
        code: "FORBIDDEN_ROLE",
        message: "Your role does not have access to this resource.",
      });
    }

    return true;
  }
}

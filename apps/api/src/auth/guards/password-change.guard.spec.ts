import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PasswordChangeGuard } from "./password-change.guard";

function contextFor(user: unknown, allowed: boolean): { context: ExecutionContext; reflector: Reflector } {
  const handler = () => undefined;
  class Controller {}
  const reflector = new Reflector();
  jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(allowed);
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => Controller,
  } as unknown as ExecutionContext;
  return { context, reflector };
}

describe("PasswordChangeGuard", () => {
  it("lets unauthenticated requests through (JwtAuthGuard decides those)", () => {
    const { context, reflector } = contextFor(undefined, false);
    expect(new PasswordChangeGuard(reflector).canActivate(context)).toBe(true);
  });

  it("lets a normal token through everywhere", () => {
    const { context, reflector } = contextFor({ sub: "u1" }, false);
    expect(new PasswordChangeGuard(reflector).canActivate(context)).toBe(true);
  });

  it("blocks a must-change-password token on an ordinary route", () => {
    const { context, reflector } = contextFor({ sub: "u1", mcp: true }, false);
    expect(() => new PasswordChangeGuard(reflector).canActivate(context)).toThrow(ForbiddenException);
  });

  it("lets a must-change-password token reach routes marked as allowed", () => {
    const { context, reflector } = contextFor({ sub: "u1", mcp: true }, true);
    expect(new PasswordChangeGuard(reflector).canActivate(context)).toBe(true);
  });

  it("reports PASSWORD_CHANGE_REQUIRED so the console can redirect", () => {
    const { context, reflector } = contextFor({ sub: "u1", mcp: true }, false);
    try {
      new PasswordChangeGuard(reflector).canActivate(context);
      fail("expected a ForbiddenException");
    } catch (err) {
      expect((err as ForbiddenException).getResponse()).toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });
    }
  });
});

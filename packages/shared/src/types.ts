import { TenantStatus, TenantType, UserRole, UserStatus } from "./enums";

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorShape;
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface TenantDto {
  id: string;
  name: string;
  type: TenantType;
  cbnLicenseNumber: string | null;
  status: TenantStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UserDto {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthUserContext {
  sub: string;
  tenantId: string;
  role: UserRole;
  email: string;
}

export interface LoginResponseDto {
  mfaRequired: boolean;
  mfaToken?: string;
  accessToken?: string;
  refreshToken?: string;
  user?: UserDto;
}

export interface CurrentUserResponseDto {
  user: UserDto;
  tenant: Pick<TenantDto, "id" | "name"> | null;
}

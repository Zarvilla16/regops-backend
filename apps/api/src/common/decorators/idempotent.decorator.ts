import { SetMetadata } from "@nestjs/common";

export const IDEMPOTENT_KEY = "idempotent";

/** Marks a write endpoint as supporting the Idempotency-Key header (see IdempotencyInterceptor). */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);

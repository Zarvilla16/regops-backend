import { BadRequestException, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { diskStorage } from "multer";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createFileStorage, FileStorage } from "@regops/file-storage";
import { UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { TenantGuard } from "../../auth/guards/tenant.guard";
import { CurrentTenant } from "../../common/decorators/current-tenant.decorator";
import { Roles } from "../../common/decorators/roles.decorator";

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * Emulates the tenant's SFTP inbox drop (spec Section 5 — see HANDOFF.md's
 * "Deviations" section for why: no real SSH/SFTP server exists in this
 * sandbox, same category of gap as the Cloudflare R2 substitution). A file
 * uploaded here lands at `tenants/<id>/sftp-inbox/<filename>`, exactly where
 * apps/worker's sftp-polling.ts looks for it — this endpoint does NOT itself
 * validate the filename pattern or create an IngestionBatch; that's the
 * poller's job (spec Section 5.2's "the MFB sees the file disappear from
 * inbox without a corresponding entry in processed" behavior only makes
 * sense if discovery, not upload, is what reacts to the file).
 */
@ApiTags("transactions")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("transactions/sftp-inbox")
export class SftpInboxController {
  private readonly storage: FileStorage;

  constructor() {
    this.storage = createFileStorage(path.resolve(__dirname, "../../../../../.local-storage"));
  }

  @Post()
  @Roles(UserRole.TENANT_ADMIN)
  @UseInterceptors(FileInterceptor("file", { storage: diskStorage({ destination: os.tmpdir() }), limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async upload(@CurrentTenant() tenantId: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException({ code: "FILE_REQUIRED", message: "A CSV file ('file' field) is required." });
    }

    // Strip any path separators from the client-supplied filename — the
    // poller is what validates the transactions-YYYYMMDD-NNN.csv pattern
    // (and quarantines anything else); this only prevents the upload itself
    // from writing outside the tenant's inbox prefix.
    const safeFilename = path.basename(file.originalname);
    const storageKey = `tenants/${tenantId}/sftp-inbox/${safeFilename}`;

    await this.storage.upload(storageKey, fs.createReadStream(file.path));
    await fs.promises.unlink(file.path).catch(() => undefined);

    return { filename: safeFilename, status: "uploaded" };
  }
}

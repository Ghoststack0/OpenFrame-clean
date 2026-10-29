import {
  BadRequestException,
  Body,
  Controller,
  Head,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { UploadFiles } from 'src/types.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AssetMediaResponseDto } from 'src/dtos/asset-media-response.dto.js';
import {
  ResumableUploadCreateDto,
  ResumableUploadFinalizeDto,
  ResumableUploadResponseDto,
} from 'src/dtos/resumable-upload.dto.js';
import { ApiTag, Permission, RouteKey } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { FileUploadInterceptor, getFiles } from 'src/middleware/file-upload.interceptor.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { ResumableUploadService } from 'src/services/resumable-upload.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
export class ResumableUploadController {
  constructor(
    private service: ResumableUploadService,
    private storage: StorageRepository,
  ) {}

  @Post('uploads')
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  @Endpoint({ summary: 'Create resumable upload', history: HistoryBuilder.v3() })
  createUpload(@Auth() auth: AuthDto, @Body() dto: ResumableUploadCreateDto): Promise<ResumableUploadResponseDto> {
    return this.service.create(auth, dto);
  }

  @Head('uploads/:id')
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  @ApiResponse({
    status: 200,
    headers: {
      'Upload-Offset': { schema: { type: 'integer' } },
      'Upload-Length': { schema: { type: 'integer' } },
      'Upload-Expires': { schema: { type: 'string' } },
    },
  })
  @Endpoint({ summary: 'Query resumable upload offset', history: HistoryBuilder.v3() })
  async headUpload(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const session = await this.service.head(auth, id);
    res.set({
      'Upload-Offset': String(session.offset),
      'Upload-Length': String(session.size),
      'Upload-Expires': session.expiresAt,
      'Cache-Control': 'no-store',
    });
  }

  @Patch('uploads/:id')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  @ApiConsumes('application/offset+octet-stream')
  @ApiHeader({ name: 'Upload-Offset', required: true, schema: { type: 'integer', minimum: 0 } })
  @ApiHeader({
    name: 'Content-Type',
    required: true,
    schema: { type: 'string', enum: ['application/offset+octet-stream'] },
  })
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @Endpoint({ summary: 'Append resumable upload chunk', history: HistoryBuilder.v3() })
  patchUpload(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Req() req: Request,
  ): Promise<ResumableUploadResponseDto> {
    const offset = req.headers['upload-offset'];
    const contentType = req.headers['content-type'];
    if (
      typeof offset !== 'string' ||
      !/^\d+$/.test(offset) ||
      !Number.isSafeInteger(Number(offset)) ||
      contentType !== 'application/offset+octet-stream'
    ) {
      throw new BadRequestException('Expected Upload-Offset and application/offset+octet-stream');
    }
    return this.service.patch(auth, id, Number(offset), req);
  }

  @Post('uploads/:id/finalize')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  @UseInterceptors(FileUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: ResumableUploadFinalizeDto })
  @Endpoint({ summary: 'Finalize resumable upload', history: HistoryBuilder.v3() })
  async finalizeUpload(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @UploadedFiles() files?: UploadFiles,
  ): Promise<AssetMediaResponseDto> {
    const { file, sidecarFile } = getFiles(files ?? { assetData: [], sidecarData: [] });
    if (file) {
      await this.storage.unlink(file.originalPath);
      if (sidecarFile) {
        await this.storage.unlink(sidecarFile.originalPath);
      }
      throw new BadRequestException('Only sidecarData is accepted at finalization');
    }
    return this.service.finalize(auth, id, sidecarFile);
  }
}

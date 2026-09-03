import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ReportService, UserService } from '@payetam/domain';
import {
  fileReportRequest,
  type FileReportRequest,
  type FileReportResponse,
} from '@payetam/shared';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { RateLimit } from '../common/rate-limit.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * Reporting, which is a **user** action on the Mini App API (plan §6).
 *
 * §6 names `POST /events/:publicId/report`; the other three target types get the
 * same shape, because a reporting system that only covers events is one that
 * cannot be used for the things that actually hurt people.
 *
 * Every response is identical whatever happens behind it. A reporter learns that
 * their report was filed and, at most, that it was the one that put the subject in
 * front of a moderator — never how many others reported, never who they were.
 * A count would let somebody probe how close a rival's event is to being hidden.
 */
@Controller('api/v1')
export class ReportsController {
  constructor(
    private readonly reports: ReportService,
    private readonly users: UserService,
  ) {}

  @Post('events/:publicId/report')
  @RateLimit('REPORT_FILE')
  @HttpCode(HttpStatus.CREATED)
  async reportEvent(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(fileReportRequest)) body: FileReportRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<FileReportResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return this.reports.file(userId, {
      targetType: 'EVENT',
      targetPublicId: publicId,
      reason: body.reason,
      ...(body.description !== undefined ? { description: body.description } : {}),
    });
  }

  @Post('users/:publicId/report')
  @RateLimit('REPORT_FILE')
  @HttpCode(HttpStatus.CREATED)
  async reportUser(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(fileReportRequest)) body: FileReportRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<FileReportResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return this.reports.file(userId, {
      targetType: 'USER',
      targetPublicId: publicId,
      reason: body.reason,
      ...(body.description !== undefined ? { description: body.description } : {}),
    });
  }

  @Post('reviews/:publicId/report')
  @RateLimit('REPORT_FILE')
  @HttpCode(HttpStatus.CREATED)
  async reportReview(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(fileReportRequest)) body: FileReportRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<FileReportResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return this.reports.file(userId, {
      targetType: 'REVIEW',
      targetPublicId: publicId,
      reason: body.reason,
      ...(body.description !== undefined ? { description: body.description } : {}),
    });
  }
}

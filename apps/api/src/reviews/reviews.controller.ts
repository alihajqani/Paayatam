import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ReviewService, UserService } from '@payetam/domain';
import {
  submitReviewRequest,
  type OwnReviewView,
  type PendingReviewsResponse,
  type SubmitReviewRequest,
  type UserReviewsResponse,
} from '@payetam/shared';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { toOwnReviewView, toPendingReviewView, toRevealedReviewView } from './review.view';

/**
 * Blind reviews (plan §6, ADR-0011 D7).
 *
 * **Invariant 8 is enforced below this controller, not in it.** There is no
 * endpoint here that reads a counterparty's unrevealed review, because
 * `ReviewService` has no method that returns one — the read path filters on the
 * pair's status, so an unrevealed review is absent from a response rather than
 * omitted from one. A controller-level check would protect this controller and
 * nothing else; the bot will reach the same service.
 */
@Controller('api/v1')
export class ReviewsController {
  constructor(
    private readonly reviews: ReviewService,
    private readonly users: UserService,
  ) {}

  /** What the caller still owes somebody, and by when. */
  @Get('me/reviews/pending')
  async pending(@CurrentUser() current: AuthenticatedUser): Promise<PendingReviewsResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    const rows = await this.reviews.listPending(userId);
    return { reviews: rows.map(toPendingReviewView) };
  }

  /**
   * Write one side of a pair.
   *
   * The response is the caller's **own** review and says whether it revealed — that
   * is, whether the counterparty had already written. It never says what they
   * wrote, and there is no shape in this module that could.
   */
  @Post('participants/:publicId/review')
  async submit(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(submitReviewRequest)) body: SubmitReviewRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<OwnReviewView> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return toOwnReviewView(
      await this.reviews.submit(userId, publicId, {
        rating: body.rating,
        tags: body.tags,
        ...(body.comment !== undefined ? { comment: body.comment } : {}),
      }),
    );
  }

  /**
   * Change your mind, within the hour and before reveal.
   *
   * A `PUT` on the same resource the `POST` created, because an edit replaces the
   * whole review — a partial edit of a rating and a comment is not a thing anybody
   * needs, and `PATCH` would invite one.
   */
  @Put('participants/:publicId/review')
  async edit(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(submitReviewRequest)) body: SubmitReviewRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<OwnReviewView> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return toOwnReviewView(
      await this.reviews.edit(userId, publicId, {
        rating: body.rating,
        tags: body.tags,
        ...(body.comment !== undefined ? { comment: body.comment } : {}),
      }),
    );
  }

  /** What the caller wrote about this participation, or 404 if they wrote nothing. */
  @Get('participants/:publicId/review')
  async own(
    @Param('publicId') publicId: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<OwnReviewView | null> {
    const userId = await this.users.resolveInternalId(current.publicId);
    const review = await this.reviews.findOwn(userId, publicId);
    return review === null ? null : toOwnReviewView(review);
  }

  /**
   * Everything the world may see about one person.
   *
   * Public because a reputation nobody can look up is not a reputation. The
   * average is computed over revealed reviews only — an average that moved when an
   * unrevealed rating landed would leak the rating through arithmetic, which is
   * the subtle way this invariant gets broken.
   */
  @Get('users/:publicId/reviews')
  async forUser(@Param('publicId') publicId: string): Promise<UserReviewsResponse> {
    const rows = await this.reviews.listForUser(publicId);
    const total = rows.reduce((sum, row) => sum + row.rating, 0);

    return {
      reviews: rows.map(toRevealedReviewView),
      averageRating: rows.length === 0 ? null : Math.round((total / rows.length) * 100) / 100,
      count: rows.length,
    };
  }
}

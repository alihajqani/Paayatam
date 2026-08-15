import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { refreshRequest, telegramAuthRequest, type AuthResponse } from '@payetam/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Public } from './auth.guard';
import { AuthService } from './auth.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Exchanges Telegram `initData` for a session.
   *
   * Public because it is how a session is obtained in the first place. Its own
   * defences are the HMAC check, the freshness window and the one-time replay
   * guard — not the auth guard.
   */
  @Public()
  @Post('telegram')
  @HttpCode(HttpStatus.OK)
  async telegram(
    @Body(new ZodValidationPipe(telegramAuthRequest)) body: { initData: string },
  ): Promise<AuthResponse> {
    return this.auth.authenticateWithTelegram(body.initData);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body(new ZodValidationPipe(refreshRequest)) body: { refreshToken: string },
  ): Promise<AuthResponse> {
    return this.auth.refresh(body.refreshToken);
  }
}

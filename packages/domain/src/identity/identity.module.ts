import { Module } from '@nestjs/common';
import type { Env } from '@payetam/config';
import { CLOCK, ENV, type Clock } from '@payetam/platform';
import { InitDataValidator } from './init-data.validator';
import { InitDataReplayGuard } from './replay-guard';
import { SessionService } from './session.service';
import { UserService } from './user.service';
import { ConsentService } from './consent.service';

export const INIT_DATA_VALIDATOR = Symbol('INIT_DATA_VALIDATOR');

/**
 * The identity module. Everything that touches a Telegram id lives behind it
 * (ADR-0009, invariant 7).
 *
 * `InitDataValidator` is provided by factory rather than as an `@Injectable` class
 * because it is a plain object with a token and a clock — keeping it free of
 * decorators is what lets its tests run with no DI container at all.
 */
@Module({
  providers: [
    {
      provide: INIT_DATA_VALIDATOR,
      inject: [ENV, CLOCK],
      useFactory: (env: Env, clock: Clock): InitDataValidator => {
        if (!env.TELEGRAM_BOT_TOKEN) {
          throw new Error(
            'TELEGRAM_BOT_TOKEN is required to validate Mini App initData. ' +
              'Set it in .env (see .env.example) before starting the API.',
          );
        }
        return new InitDataValidator(env.TELEGRAM_BOT_TOKEN, clock);
      },
    },
    InitDataReplayGuard,
    SessionService,
    UserService,
    ConsentService,
  ],
  exports: [INIT_DATA_VALIDATOR, InitDataReplayGuard, SessionService, UserService, ConsentService],
})
export class IdentityModule {}

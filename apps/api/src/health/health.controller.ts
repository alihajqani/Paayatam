import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/auth.guard';
import { HealthService } from './health.service';

/**
 * Liveness and readiness.
 *
 * The distinction matters to the orchestrator: a failing `/health` should restart
 * the process, whereas a failing `/ready` should only stop routing traffic to it.
 * Conflating them means a brief database blip restarts an otherwise healthy API.
 */
/**
 * `@Public()` on the class: the global AuthGuard is deny-by-default, so without
 * this the orchestrator's probes get 401 and the container is restarted forever.
 * Neither endpoint discloses anything — liveness is a constant, readiness reports
 * only up/down per dependency.
 */
@Public()
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: is the process running? Checks nothing external, by design. */
  @Get('health')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /** Readiness: can this instance actually serve requests? Checks its dependencies. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.health.checkDependencies();
    reply.status(result.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}

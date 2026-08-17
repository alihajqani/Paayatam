import fastifyCookie from '@fastify/cookie';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Registers cookie parsing on a Fastify application.
 *
 * A **function both composition points call**, rather than a provider inside
 * `AppModule`. That is a concession to Fastify rather than a preference: a plugin
 * has to be registered on the instance before Nest boots it, and a module provider
 * runs during `init()` — too late for `request.cookies` to exist by the time the
 * first request arrives. M6 moved the exception filter *into* the module for
 * exactly the opposite reason; this one cannot go there.
 *
 * The risk that creates is the one M6 was fixing: a second composition of the app
 * that forgets to call this has an admin API answering 401 to everything. The
 * response-leak scan is the guard — it calls this and then asserts that admin
 * reads actually succeed, so forgetting it fails a test rather than shipping.
 *
 * No `secret`: these cookies are not signed. The session value is 256 bits from a
 * CSPRNG and is looked up in Redis on every request, so a forged cookie fails at
 * the lookup rather than at a signature — signing would add a second thing to keep
 * secret without removing the lookup.
 */
export async function registerCookies(app: NestFastifyApplication): Promise<void> {
  // Cast because `@fastify/cookie`'s own types describe the instance it produces
  // (one that has `parseCookie`), which by definition is not the instance it is
  // being registered on. Nest's `register` signature has no way to express that.
  await app.register(fastifyCookie as unknown as Parameters<typeof app.register>[0]);
}

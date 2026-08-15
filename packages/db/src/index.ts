export { PrismaService } from './prisma.service';
export { PrismaModule } from './prisma.module';

// Re-exported so consumers import model and enum types from `@payetam/db` rather
// than reaching into the generated directory, which keeps the generator's output
// path an implementation detail of this package.
export { Prisma, PrismaClient } from './generated/prisma/client';
export * from './generated/prisma/enums';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@payetam/db';
import { PERMISSIONS, ROLE_NAMES_FA, ROLE_PERMISSIONS, ROLE_KEYS } from '@payetam/domain';

/**
 * Seeds `role`, `permission` and `role_permission` from the catalogue in code.
 *
 * The catalogue in `packages/domain/adminaccess/permissions.ts` is the source of
 * truth and this script is what puts it in the database — not the other way round.
 * That direction matters: the RBAC matrix test reads the same constant, so a
 * permission added in code and never seeded shows up as a failing test rather than
 * as a moderator who quietly cannot do their job.
 *
 * Idempotent, so it runs on every deploy. Grants that are no longer in the
 * catalogue are removed, which is the half that is easy to skip and is the half
 * that matters — a permission revoked in code but left in the database is a
 * capability nobody believes anybody has.
 */
async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    for (const key of Object.values(PERMISSIONS)) {
      await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }

    for (const roleKey of Object.values(ROLE_KEYS)) {
      const role = await prisma.role.upsert({
        where: { key: roleKey },
        update: { name: ROLE_NAMES_FA[roleKey] },
        create: { key: roleKey, name: ROLE_NAMES_FA[roleKey] },
      });

      const wanted = await prisma.permission.findMany({
        where: { key: { in: [...ROLE_PERMISSIONS[roleKey]] } },
        select: { id: true },
      });

      await prisma.rolePermission.createMany({
        data: wanted.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
        skipDuplicates: true,
      });

      // The revoking half. Without it, a permission removed from the catalogue
      // stays granted forever and the table stops describing the product.
      await prisma.rolePermission.deleteMany({
        where: { roleId: role.id, permissionId: { notIn: wanted.map((row) => row.id) } },
      });
    }

    const roles = await prisma.role.count();
    const permissions = await prisma.permission.count();
    console.log(`Seeded ${String(roles)} roles and ${String(permissions)} permissions.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

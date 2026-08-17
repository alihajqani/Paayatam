import { PERMISSIONS, ROLE_NAMES_FA, ROLE_PERMISSIONS, ROLE_KEYS } from '@payetam/domain';
import { openSeed } from './seed-guard';

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
 *
 * **The one seed exempt from M17's interactive rail**, via `unattended`. This runs on
 * every deploy and has to: a prompt in front of it would either break the deploy or
 * teach somebody to pipe an answer at a production confirmation, which is worse than
 * having no confirmation. It still writes the audit row, because changing what staff
 * can do in production without a record is what invariant 12 exists to prevent.
 */
async function main(): Promise<void> {
  const { prisma, finish } = await openSeed(
    'seed.rbac',
    'This writes the staff roles and permissions the admin panel authorises against.',
    { unattended: true },
  );

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
    await finish({ roles, permissions });
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

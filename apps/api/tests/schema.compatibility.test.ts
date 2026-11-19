import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('Relational Schema & Constraint Compatibility', () => {
  const testIds: { userId?: string; challengeId?: string; compId?: string } = {};

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    if (testIds.challengeId) {
      await prisma.challenge.deleteMany({ where: { id: testIds.challengeId } });
    }
    if (testIds.compId) {
      await prisma.competition.deleteMany({ where: { id: testIds.compId } });
    }
    if (testIds.userId) {
      await prisma.user.deleteMany({ where: { id: testIds.userId } });
    }
    await prisma.$disconnect();
  });

  it('contains all 7 seeded system roles and 9 categories', async () => {
    const roles = await prisma.role.count();
    const categories = await prisma.category.count();
    expect(roles).toBeGreaterThanOrEqual(7);
    expect(categories).toBeGreaterThanOrEqual(9);
  });

  it('enforces unique Solve constraint against duplicate user solves', async () => {
    const suffix = Date.now().toString(36);
    const user = await prisma.user.create({
      data: {
        username: `test_${suffix}`,
        displayName: 'Test User',
        email: `test_${suffix}@dusklabs.local`,
        passwordHash: 'placeholder-hash',
      },
    });
    testIds.userId = user.id;

    const comp = await prisma.competition.create({
      data: {
        slug: `comp-${suffix}`,
        title: 'Constraint Test Comp',
        description: 'Testing DB constraints',
        rules: 'Standard rules',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 3_600_000),
        createdById: user.id,
      },
    });
    testIds.compId = comp.id;

    const challenge = await prisma.challenge.create({
      data: {
        slug: `chal-${suffix}`,
        title: 'Web Challenge 1',
        description: 'Inspect the artifact',
        difficulty: 'EASY',
        points: 100,
        initialPoints: 100,
        competitionId: comp.id,
        authorId: user.id,
      },
    });
    testIds.challengeId = challenge.id;

    await prisma.solve.create({
      data: {
        challengeId: challenge.id,
        competitionId: comp.id,
        userId: user.id,
        pointsAwarded: 100,
      },
    });

    await expect(
      prisma.solve.create({
        data: {
          challengeId: challenge.id,
          competitionId: comp.id,
          userId: user.id,
          pointsAwarded: 100,
        },
      }),
    ).rejects.toThrow();
  });
});

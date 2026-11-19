import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { decryptSecret, deriveDynamicFlag } from '../src/utils/flagCrypto.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 3 Step 3.2 — Challenge Management, Lifecycle, Competition Access & Flag Secrecy', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0003',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00003',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  let appCtx: Awaited<ReturnType<typeof buildApp>>;
  const cleanupUsers: string[] = [];
  const cleanupChallenges: string[] = [];
  const cleanupComps: string[] = [];

  async function createUserWithRole(tag: string, roleName?: string) {
    const username = `ch_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'ChallengeStrongPass!123';
    const reg = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username, displayName: `User ${tag}`, email, password },
    });
    const userId = reg.json().user.id as string;
    cleanupUsers.push(userId);

    if (roleName) {
      const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
      await prisma.userRole.create({ data: { userId, roleId: role.id } });
    }

    const login = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: username, password },
    });

    return {
      userId,
      username,
      cookie: cookieOf(login),
      csrf: login.json().csrfToken as string,
    };
  }

  beforeAll(async () => {
    await prisma.$connect();
    appCtx = await buildApp({ env, prisma, authRateLimitMax: 100 });
  });

  afterAll(async () => {
    if (cleanupChallenges.length) {
      await prisma.challenge.deleteMany({ where: { id: { in: cleanupChallenges } } });
    }
    if (cleanupComps.length) {
      await prisma.competition.deleteMany({ where: { id: { in: cleanupComps } } });
    }
    if (cleanupUsers.length) {
      await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    }
    await appCtx.app.close();
    await prisma.$disconnect();
  });

  it('enforces RBAC, lifecycle transitions, flag secrecy, and category/tag filtering', async () => {
    const admin = await createUserWithRole('adm', 'PLATFORM_ADMIN');
    const author1 = await createUserWithRole('auth1', 'CHALLENGE_AUTHOR');
    const author2 = await createUserWithRole('auth2', 'CHALLENGE_AUTHOR');
    const player = await createUserWithRole('ply');

    const webCat = await prisma.category.findUniqueOrThrow({ where: { slug: 'web-exploitation' } });

    const deniedCreate = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/challenges',
      headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
      payload: {
        slug: `denied-${suffix}`,
        title: 'Denied',
        description: 'Should fail RBAC',
        difficulty: 'EASY',
        points: 100,
        initialPoints: 100,
        categoryIds: [webCat.id],
      },
    });
    expect(deniedCreate.statusCode).toBe(403);

    const createRes = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/challenges',
      headers: { cookie: author1.cookie, 'x-csrf-token': author1.csrf },
      payload: {
        slug: `webchal1-${suffix}`,
        title: 'SQL Injection Artifact',
        description: 'Inspect the source bundle to recover the secret.',
        difficulty: 'EASY',
        points: 150,
        initialPoints: 150,
        categoryIds: [webCat.id],
        tags: ['SQLi', 'SQLite'],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const challengeId = createRes.json().challenge.id as string;
    cleanupChallenges.push(challengeId);

    const publishNoFlag = await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${challengeId}/transition`,
      headers: { cookie: author1.cookie, 'x-csrf-token': author1.csrf },
      payload: { targetStatus: 'PUBLISHED' },
    });
    expect(publishNoFlag.statusCode).toBe(400);
    expect(publishNoFlag.json().error.code).toBe('FLAG_REQUIRED_BEFORE_PUBLISH');

    // IDOR check: Author2 cannot configure flag on Author1's challenge
    const idorFlag = await appCtx.app.inject({
      method: 'PUT',
      url: `/api/v1/challenges/${challengeId}/flag`,
      headers: { cookie: author2.cookie, 'x-csrf-token': author2.csrf },
      payload: { flagType: 'STATIC_EXACT', flagValue: 'DUSK{stolen_flag}' },
    });
    expect(idorFlag.statusCode).toBe(403);

    const secretFlag = 'DUSK{sqli_static_flag_2025}';
    const setFlag = await appCtx.app.inject({
      method: 'PUT',
      url: `/api/v1/challenges/${challengeId}/flag`,
      headers: { cookie: author1.cookie, 'x-csrf-token': author1.csrf },
      payload: { flagType: 'STATIC_EXACT', flagValue: secretFlag },
    });
    expect(setFlag.statusCode).toBe(200);
    expect(JSON.stringify(setFlag.json())).not.toContain(secretFlag);

    // Unpublished challenge returns 404 to participants
    const draftView = await appCtx.app.inject({
      method: 'GET',
      url: `/api/v1/challenges/webchal1-${suffix}`,
      headers: { cookie: player.cookie },
    });
    expect(draftView.statusCode).toBe(404);

    // DRAFT -> TESTING -> PUBLISHED
    await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${challengeId}/transition`,
      headers: { cookie: author1.cookie, 'x-csrf-token': author1.csrf },
      payload: { targetStatus: 'TESTING' },
    });
    const pubRes = await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${challengeId}/transition`,
      headers: { cookie: author1.cookie, 'x-csrf-token': author1.csrf },
      payload: { targetStatus: 'PUBLISHED' },
    });
    expect(pubRes.statusCode).toBe(200);

    // Invalid transition: ARCHIVED -> PUBLISHED directly must fail
    await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${challengeId}/transition`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { targetStatus: 'ARCHIVED' },
    });
    const invalidTrans = await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${challengeId}/transition`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { targetStatus: 'PUBLISHED' },
    });
    expect(invalidTrans.statusCode).toBe(400);

    await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${challengeId}/transition`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { targetStatus: 'DRAFT' },
    });
    await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${challengeId}/transition`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { targetStatus: 'PUBLISHED' },
    });

    const listRes = await appCtx.app.inject({
      method: 'GET',
      url: `/api/v1/challenges?category=web-exploitation&tag=sqli&search=SQL`,
      headers: { cookie: player.cookie },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().challenges.some((c: any) => c.id === challengeId)).toBe(true);
    expect(JSON.stringify(listRes.json())).not.toContain(secretFlag);
  });

  it('enforces competition access restrictions and dynamic per-participant flag verification', async () => {
    const admin = await createUserWithRole('cadm', 'PLATFORM_ADMIN');
    const regPlayer = await createUserWithRole('creg');
    const unregPlayer = await createUserWithRole('cunreg');
    const cryptoCat = await prisma.category.findUniqueOrThrow({ where: { slug: 'cryptography' } });

    const comp = await prisma.competition.create({
      data: {
        slug: `chal-comp-${suffix}`,
        title: 'Closed Access CTF',
        description: 'Testing competition challenge gating',
        rules: 'No sharing flags',
        status: 'LIVE',
        participationMode: 'INDIVIDUAL',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 3_600_000),
        createdById: admin.userId,
      },
    });
    cleanupComps.push(comp.id);

    await prisma.competitionRegistration.create({
      data: { competitionId: comp.id, userId: regPlayer.userId },
    });

    const createDyn = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/challenges',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: {
        slug: `dyn-crypto-${suffix}`,
        title: 'Dynamic Seed Challenge',
        description: 'Each registered participant receives a unique derived flag.',
        difficulty: 'MEDIUM',
        status: 'PUBLISHED',
        isVisible: true,
        points: 250,
        initialPoints: 250,
        competitionId: comp.id,
        categoryIds: [cryptoCat.id],
        flagConfig: {
          flagType: 'DYNAMIC_HMAC_PATTERN',
          flagValue: 'master-seed-material',
          dynamicPattern: 'DUSK{dyn_{{TOKEN}}}',
        },
      },
    });
    expect(createDyn.statusCode).toBe(201);
    const dynId = createDyn.json().challenge.id as string;
    cleanupChallenges.push(dynId);

    const blocked = await appCtx.app.inject({
      method: 'GET',
      url: `/api/v1/challenges/dyn-crypto-${suffix}`,
      headers: { cookie: unregPlayer.cookie },
    });
    expect(blocked.statusCode).toBe(403);

    const allowed = await appCtx.app.inject({
      method: 'GET',
      url: `/api/v1/challenges/dyn-crypto-${suffix}`,
      headers: { cookie: regPlayer.cookie },
    });
    expect(allowed.statusCode).toBe(200);

    const storedFlag = await prisma.flagConfiguration.findUniqueOrThrow({ where: { challengeId: dynId } });
    const seed = decryptSecret(storedFlag.encryptedFlag!, env.FLAG_ENCRYPTION_KEY);
    const derivedForReg = deriveDynamicFlag({
      seed,
      pattern: storedFlag.dynamicPattern!,
      challengeId: dynId,
      participantKey: regPlayer.userId,
    });

    const dryRunOk = await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${dynId}/test-flag`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { candidateFlag: derivedForReg, participantKey: regPlayer.userId },
    });
    expect(dryRunOk.statusCode).toBe(200);
    expect(dryRunOk.json().valid).toBe(true);

    const dryRunWrongUser = await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${dynId}/test-flag`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { candidateFlag: derivedForReg, participantKey: unregPlayer.userId },
    });
    expect(dryRunWrongUser.json().valid).toBe(false);
  });
});

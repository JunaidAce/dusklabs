import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 3 Step 3.1 — Teams, Invitations, Requests & Competition Constraints', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0002',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00002',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  let appCtx: Awaited<ReturnType<typeof buildApp>>;
  const cleanupUsers: string[] = [];
  const cleanupTeams: string[] = [];
  const cleanupComps: string[] = [];

  async function registerAndLogin(tag: string) {
    const username = `tm_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'TeamStrongPassword!123';
    const reg = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username, displayName: `User ${tag}`, email, password },
    });
    const userId = reg.json().user.id as string;
    cleanupUsers.push(userId);

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
    if (cleanupComps.length) {
      await prisma.competition.deleteMany({ where: { id: { in: cleanupComps } } });
    }
    if (cleanupTeams.length) {
      await prisma.team.deleteMany({ where: { id: { in: cleanupTeams } } });
    }
    if (cleanupUsers.length) {
      await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    }
    await appCtx.app.close();
    await prisma.$disconnect();
  });

  it('creates team, protects inviteCode from public, and processes invitation + join request workflows', async () => {
    const cap = await registerAndLogin('cap');
    const p2 = await registerAndLogin('p2');
    const p3 = await registerAndLogin('p3');

    // Create team
    const createRes = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: { cookie: cap.cookie, 'x-csrf-token': cap.csrf },
      payload: { name: `ShadowOps_${suffix}`, bio: 'Binary and Web specialists' },
    });
    expect(createRes.statusCode).toBe(201);
    const team = createRes.json().team;
    cleanupTeams.push(team.id);

    // Public viewer must NOT see inviteCode or pendingInvitations
    const publicView = await appCtx.app.inject({
      method: 'GET',
      url: `/api/v1/teams/${team.slug}`,
    });
    expect(publicView.statusCode).toBe(200);
    expect(publicView.json().inviteCode).toBeUndefined();
    expect(publicView.json().pendingInvitations).toBeUndefined();

    // Captain sees inviteCode
    const capView = await appCtx.app.inject({
      method: 'GET',
      url: `/api/v1/teams/${team.slug}`,
      headers: { cookie: cap.cookie },
    });
    expect(capView.json().inviteCode).toBeDefined();

    // Captain invites p2; p3 cannot accept p2's invitation (IDOR check)
    const invRes = await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/teams/${team.id}/invitations`,
      headers: { cookie: cap.cookie, 'x-csrf-token': cap.csrf },
      payload: { username: p2.username },
    });
    expect(invRes.statusCode).toBe(201);
    const invitationId = invRes.json().invitation.id;

    const idorAccept = await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/teams/invitations/${invitationId}/respond`,
      headers: { cookie: p3.cookie, 'x-csrf-token': p3.csrf },
      payload: { action: 'ACCEPT' },
    });
    expect(idorAccept.statusCode).toBe(403);

    const p2Accept = await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/teams/invitations/${invitationId}/respond`,
      headers: { cookie: p2.cookie, 'x-csrf-token': p2.csrf },
      payload: { action: 'ACCEPT' },
    });
    expect(p2Accept.statusCode).toBe(200);

    // p3 submits join request; p2 (non-captain) cannot approve it; captain approves it
    const reqRes = await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/teams/${team.id}/requests`,
      headers: { cookie: p3.cookie, 'x-csrf-token': p3.csrf },
      payload: { message: 'Crypto solver here' },
    });
    expect(reqRes.statusCode).toBe(201);
    const requestId = reqRes.json().request.id;

    const nonCapApprove = await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/teams/invitations/${requestId}/respond`,
      headers: { cookie: p2.cookie, 'x-csrf-token': p2.csrf },
      payload: { action: 'ACCEPT' },
    });
    expect(nonCapApprove.statusCode).toBe(403);

    const capApprove = await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/teams/invitations/${requestId}/respond`,
      headers: { cookie: cap.cookie, 'x-csrf-token': cap.csrf },
      payload: { action: 'ACCEPT' },
    });
    expect(capApprove.statusCode).toBe(200);

    // Verify 3 members & transfer captaincy to p2
    const afterJoin = await appCtx.app.inject({
      method: 'GET',
      url: `/api/v1/teams/${team.slug}`,
      headers: { cookie: cap.cookie },
    });
    expect(afterJoin.json().members).toHaveLength(3);

    const transferRes = await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/teams/${team.id}/transfer-captain`,
      headers: { cookie: cap.cookie, 'x-csrf-token': cap.csrf },
      payload: { newCaptainUserId: p2.userId },
    });
    expect(transferRes.statusCode).toBe(200);
  });

  it('enforces competition maxTeamSize and LIVE roster lock', async () => {
    const cap = await registerAndLogin('limcap');
    const m2 = await registerAndLogin('lim2');
    const m3 = await registerAndLogin('lim3');

    const createRes = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: { cookie: cap.cookie, 'x-csrf-token': cap.csrf },
      payload: { name: `LimitSquad_${suffix}` },
    });
    const team = createRes.json().team;
    cleanupTeams.push(team.id);

    // Create a SCHEDULED competition with maxTeamSize = 2
    const comp = await prisma.competition.create({
      data: {
        slug: `lim-comp-${suffix}`,
        title: 'Team Size Limit Cup',
        description: 'Testing maxTeamSize=2',
        rules: 'Standard rules',
        status: 'SCHEDULED',
        participationMode: 'TEAM',
        maxTeamSize: 2,
        lockTeamRosterOnLive: true,
        startsAt: new Date(Date.now() + 3_600_000),
        endsAt: new Date(Date.now() + 7_200_000),
        createdById: cap.userId,
      },
    });
    cleanupComps.push(comp.id);

    await prisma.competitionTeam.create({
      data: { competitionId: comp.id, teamId: team.id },
    });

    // m2 joins via code -> allowed (size 2/2)
    const join2 = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/teams/join-by-code',
      headers: { cookie: m2.cookie, 'x-csrf-token': m2.csrf },
      payload: { inviteCode: team.inviteCode },
    });
    expect(join2.statusCode).toBe(200);

    // m3 tries to join -> blocked (exceeds maxTeamSize=2)
    const join3 = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/teams/join-by-code',
      headers: { cookie: m3.cookie, 'x-csrf-token': m3.csrf },
      payload: { inviteCode: team.inviteCode },
    });
    expect(join3.statusCode).toBe(409);
    expect(join3.json().error.code).toBe('TEAM_SIZE_LIMIT_REACHED');

    // Transition competition to LIVE -> m2 cannot leave or be removed while locked
    await prisma.competition.update({
      where: { id: comp.id },
      data: { status: 'LIVE' },
    });

    const leaveLive = await appCtx.app.inject({
      method: 'POST',
      url: `/api/v1/teams/${team.id}/leave`,
      headers: { cookie: m2.cookie, 'x-csrf-token': m2.csrf },
    });
    expect(leaveLive.statusCode).toBe(409);
    expect(leaveLive.json().error.code).toBe('ROSTER_LOCKED');
  });
});

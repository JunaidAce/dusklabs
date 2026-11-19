import type { RoleName } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import { buildRfc4180Csv, sanitizeCsvFilename } from '../../utils/csv.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ScoringService } from '../scoring/scoring.service.js';

export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly scoringService: ScoringService,
  ) {}

  private isPlatformAdmin(auth: AuthenticatedContext): boolean {
    return (
      auth.roles.includes('SUPER_ADMIN' satisfies RoleName) ||
      auth.roles.includes('PLATFORM_ADMIN' satisfies RoleName)
    );
  }

  private async assertCompetitionAnalyticsAccess(
    auth: AuthenticatedContext,
    competitionId: string,
  ) {
    const comp = await this.prisma.competition.findUnique({ where: { id: competitionId } });
    if (!comp) throw new NotFoundError('Competition not found');

    if (this.isPlatformAdmin(auth)) return comp;
    if (auth.roles.includes('COMPETITION_ORGANIZER')) {
      if (comp.createdById === auth.userId) return comp;
      const assigned = await this.prisma.competitionOrganizer.findUnique({
        where: { competitionId_userId: { competitionId, userId: auth.userId } },
      });
      if (assigned) return comp;
    }

    throw new ForbiddenError('You are not authorized to access analytics for this competition');
  }

  private async getChallengeStatsInternal(competitionId?: string) {
    const [challenges, submissions, solves] = await Promise.all([
      this.prisma.challenge.findMany({
        where: competitionId ? { competitionId } : {},
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          slug: true,
          title: true,
          difficulty: true,
          points: true,
          status: true,
          firstBloodUserId: true,
          firstBloodAt: true,
          categories: { select: { category: { select: { slug: true, name: true } } } },
        },
      }),
      this.prisma.submission.findMany({
        where: competitionId ? { competitionId } : {},
        select: { challengeId: true, isCorrect: true, submittedAt: true },
      }),
      this.prisma.solve.findMany({
        where: competitionId ? { competitionId } : {},
        select: {
          challengeId: true,
          isFirstBlood: true,
          solvedAt: true,
          user: { select: { username: true } },
          team: { select: { name: true } },
        },
      }),
    ]);

    const attemptsByChal = new Map<string, { total: number; correct: number; incorrect: number }>();
    for (const s of submissions) {
      const cur = attemptsByChal.get(s.challengeId) ?? { total: 0, correct: 0, incorrect: 0 };
      cur.total++;
      if (s.isCorrect) cur.correct++;
      else cur.incorrect++;
      attemptsByChal.set(s.challengeId, cur);
    }

    const fbByChal = new Map<
      string,
      { username: string; teamName: string | null; solvedAt: Date }
    >();
    const solveCountByChal = new Map<string, number>();
    for (const sv of solves) {
      solveCountByChal.set(sv.challengeId, (solveCountByChal.get(sv.challengeId) ?? 0) + 1);
      if (sv.isFirstBlood) {
        fbByChal.set(sv.challengeId, {
          username: sv.user.username,
          teamName: sv.team?.name ?? null,
          solvedAt: sv.solvedAt,
        });
      }
    }

    return challenges.map((c) => {
      const att = attemptsByChal.get(c.id) ?? { total: 0, correct: 0, incorrect: 0 };
      const solveCount = solveCountByChal.get(c.id) ?? 0;
      const solveRatePercent =
        att.total > 0 ? Math.round((att.correct / att.total) * 1000) / 10 : 0;

      return {
        id: c.id,
        slug: c.slug,
        title: c.title,
        difficulty: c.difficulty,
        points: c.points,
        status: c.status,
        categories: c.categories.map((cc) => cc.category),
        totalAttempts: att.total,
        correctAttempts: att.correct,
        incorrectAttempts: att.incorrect,
        solveCount,
        solveRatePercent,
        firstBlood: fbByChal.get(c.id) ?? null,
      };
    });
  }

  async getPlatformAnalytics(auth: AuthenticatedContext) {
    const isAdmin = this.isPlatformAdmin(auth);
    let scopedCompIds: string[] | null = null;
    if (!isAdmin) {
      const owned = await this.prisma.competition.findMany({
        where: {
          OR: [{ createdById: auth.userId }, { organizers: { some: { userId: auth.userId } } }],
        },
        select: { id: true },
      });
      scopedCompIds = owned.map((c) => c.id);
    }

    const [challenges, submissions, categories] = await Promise.all([
      this.prisma.challenge.findMany({
        where: scopedCompIds ? { competitionId: { in: scopedCompIds } } : {},
        select: {
          id: true,
          slug: true,
          title: true,
          difficulty: true,
          categories: { select: { category: { select: { slug: true, name: true } } } },
          _count: { select: { solves: true, submissions: true } },
        },
      }),
      this.prisma.submission.findMany({
        where: scopedCompIds ? { competitionId: { in: scopedCompIds } } : {},
        orderBy: { submittedAt: 'asc' },
        select: { isCorrect: true, submittedAt: true },
      }),
      this.prisma.category.findMany({ orderBy: { sortOrder: 'asc' } }),
    ]);

    // Submission volume grouped by UTC day
    const volumeByDay = new Map<string, { date: string; total: number; valid: number; failed: number }>();
    let totalCorrect = 0;
    for (const s of submissions) {
      if (s.isCorrect) totalCorrect++;
      const day = s.submittedAt.toISOString().slice(0, 10);
      const bucket = volumeByDay.get(day) ?? { date: day, total: 0, valid: 0, failed: 0 };
      bucket.total++;
      if (s.isCorrect) bucket.valid++;
      else bucket.failed++;
      volumeByDay.set(day, bucket);
    }

    // Category & difficulty breakdown
    const diffMap = new Map<string, { difficulty: string; challengeCount: number; totalSolves: number }>();
    const catMap = new Map<string, { slug: string; name: string; challengeCount: number; totalSolves: number }>();
    for (const cat of categories) {
      catMap.set(cat.slug, { slug: cat.slug, name: cat.name, challengeCount: 0, totalSolves: 0 });
    }

    for (const c of challenges) {
      const d = diffMap.get(c.difficulty) ?? {
        difficulty: c.difficulty,
        challengeCount: 0,
        totalSolves: 0,
      };
      d.challengeCount++;
      d.totalSolves += c._count.solves;
      diffMap.set(c.difficulty, d);

      for (const cc of c.categories) {
        const cEntry = catMap.get(cc.category.slug);
        if (cEntry) {
          cEntry.challengeCount++;
          cEntry.totalSolves += c._count.solves;
        }
      }
    }

    const sortedBySolves = [...challenges].sort((a, b) => b._count.solves - a._count.solves);
    const withAttempts = challenges.filter((c) => c._count.submissions > 0);
    const hardest = [...withAttempts].sort((a, b) => {
      const rateA = a._count.solves / a._count.submissions;
      const rateB = b._count.solves / b._count.submissions;
      return rateA - rateB;
    });

    return {
      scope: isAdmin ? 'GLOBAL' : 'ORGANIZER_SCOPED',
      totals: {
        challenges: challenges.length,
        submissions: submissions.length,
        validSubmissions: totalCorrect,
        failedSubmissions: submissions.length - totalCorrect,
        overallSolveRatePercent:
          submissions.length > 0
            ? Math.round((totalCorrect / submissions.length) * 1000) / 10
            : 0,
      },
      mostSolvedChallenge: sortedBySolves[0]
        ? {
            slug: sortedBySolves[0].slug,
            title: sortedBySolves[0].title,
            solveCount: sortedBySolves[0]._count.solves,
          }
        : null,
      hardestChallenge: hardest[0]
        ? {
            slug: hardest[0].slug,
            title: hardest[0].title,
            solveCount: hardest[0]._count.solves,
            attemptCount: hardest[0]._count.submissions,
          }
        : null,
      categoryPerformance: Array.from(catMap.values()),
      difficultyPerformance: Array.from(diffMap.values()),
      submissionVolumeTimeline: Array.from(volumeByDay.values()).slice(-30),
    };
  }

  async getCompetitionAnalytics(auth: AuthenticatedContext, competitionId: string) {
    const comp = await this.assertCompetitionAnalyticsAccess(auth, competitionId);

    const [
      confirmedIndivRegs,
      confirmedTeams,
      submissions,
      solves,
      challengeStats,
      standings,
    ] = await Promise.all([
      this.prisma.competitionRegistration.count({
        where: { competitionId, status: 'CONFIRMED' },
      }),
      this.prisma.competitionTeam.count({
        where: { competitionId, status: 'CONFIRMED' },
      }),
      this.prisma.submission.findMany({
        where: { competitionId },
        orderBy: { submittedAt: 'asc' },
        select: { userId: true, teamId: true, isCorrect: true, submittedAt: true },
      }),
      this.prisma.solve.findMany({
        where: { competitionId },
        select: { userId: true, teamId: true },
      }),
      this.getChallengeStatsInternal(competitionId),
      this.scoringService.computeStandings({
        competitionId,
        entityType: comp.participationMode === 'TEAM' ? 'TEAM' : 'INDIVIDUAL',
        allowNegative: comp.allowNegativeScores,
      }),
    ]);

    const activeParticipantIds = new Set<string>();
    const activeTeamIds = new Set<string>();
    const timelineMap = new Map<string, { bucket: string; total: number; valid: number; failed: number }>();

    for (const s of submissions) {
      activeParticipantIds.add(s.userId);
      if (s.teamId) activeTeamIds.add(s.teamId);
      const hourBucket = `${s.submittedAt.toISOString().slice(0, 13)}:00Z`;
      const b = timelineMap.get(hourBucket) ?? { bucket: hourBucket, total: 0, valid: 0, failed: 0 };
      b.total++;
      if (s.isCorrect) b.valid++;
      else b.failed++;
      timelineMap.set(hourBucket, b);
    }

    const diffCounts = new Map<string, { difficulty: string; challenges: number; solves: number }>();
    const catCounts = new Map<string, { slug: string; name: string; challenges: number; solves: number }>();
    for (const cs of challengeStats) {
      const d = diffCounts.get(cs.difficulty) ?? { difficulty: cs.difficulty, challenges: 0, solves: 0 };
      d.challenges++;
      d.solves += cs.solveCount;
      diffCounts.set(cs.difficulty, d);

      for (const cat of cs.categories) {
        const c = catCounts.get(cat.slug) ?? { slug: cat.slug, name: cat.name, challenges: 0, solves: 0 };
        c.challenges++;
        c.solves += cs.solveCount;
        catCounts.set(cat.slug, c);
      }
    }

    return {
      competition: {
        id: comp.id,
        slug: comp.slug,
        title: comp.title,
        status: comp.status,
        participationMode: comp.participationMode,
        scoringMode: comp.scoringMode,
      },
      summary: {
        confirmedParticipants: confirmedIndivRegs,
        confirmedTeams,
        activeParticipants: activeParticipantIds.size,
        activeTeams: activeTeamIds.size,
        totalSubmissions: submissions.length,
        totalSolves: solves.length,
      },
      challengeStats,
      categoryDistribution: Array.from(catCounts.values()),
      difficultyDistribution: Array.from(diffCounts.values()),
      submissionTimeline: Array.from(timelineMap.values()).slice(-48),
      standings: standings.slice(0, 50),
    };
  }

  async exportStandingsCsv(
    auth: AuthenticatedContext,
    competitionId: string,
    meta: { correlationId?: string; ipAddress?: string },
  ) {
    const comp = await this.assertCompetitionAnalyticsAccess(auth, competitionId);
    const entityType = comp.participationMode === 'TEAM' ? 'TEAM' : 'INDIVIDUAL';
    const standings = await this.scoringService.computeStandings({
      competitionId,
      entityType,
      allowNegative: comp.allowNegativeScores,
    });

    const csv = buildRfc4180Csv(
      ['Rank', 'EntityType', 'Name', 'Handle', 'Country', 'TotalPoints', 'SolvedCount', 'FirstBloods', 'LastSolveAt'],
      standings.map((e) => [
        e.rank,
        e.entityType,
        e.name,
        e.slugOrUsername,
        e.country ?? '',
        e.totalPoints,
        e.solveCount,
        e.firstBloodCount,
        e.lastSolveAt ?? '',
      ]),
    );

    await this.audit.record({
      actorId: auth.userId,
      category: 'SCORING',
      action: 'ANALYTICS_CSV_EXPORTED',
      entityType: 'Competition',
      entityId: comp.id,
      metadata: { exportType: 'STANDINGS', rowCount: standings.length },
      correlationId: meta.correlationId,
      ipAddress: meta.ipAddress,
    });

    return {
      filename: sanitizeCsvFilename(comp.slug, 'standings'),
      csv,
    };
  }

  async exportChallengeStatsCsv(
    auth: AuthenticatedContext,
    competitionId: string,
    meta: { correlationId?: string; ipAddress?: string },
  ) {
    const comp = await this.assertCompetitionAnalyticsAccess(auth, competitionId);
    const stats = await this.getChallengeStatsInternal(comp.id);

    const csv = buildRfc4180Csv(
      ['Slug', 'Title', 'Difficulty', 'Points', 'Status', 'TotalAttempts', 'CorrectAttempts', 'IncorrectAttempts', 'SolveCount', 'SolveRatePercent', 'FirstBloodUser', 'FirstBloodAt'],
      stats.map((s) => [
        s.slug,
        s.title,
        s.difficulty,
        s.points,
        s.status,
        s.totalAttempts,
        s.correctAttempts,
        s.incorrectAttempts,
        s.solveCount,
        s.solveRatePercent,
        s.firstBlood?.username ?? '',
        s.firstBlood?.solvedAt ?? '',
      ]),
    );

    await this.audit.record({
      actorId: auth.userId,
      category: 'CHALLENGE',
      action: 'ANALYTICS_CSV_EXPORTED',
      entityType: 'Competition',
      entityId: comp.id,
      metadata: { exportType: 'CHALLENGE_STATS', rowCount: stats.length },
      correlationId: meta.correlationId,
      ipAddress: meta.ipAddress,
    });

    return {
      filename: sanitizeCsvFilename(comp.slug, 'challenge-stats'),
      csv,
    };
  }

  async exportSubmissionsSummaryCsv(
    auth: AuthenticatedContext,
    competitionId: string,
    meta: { correlationId?: string; ipAddress?: string },
  ) {
    const comp = await this.assertCompetitionAnalyticsAccess(auth, competitionId);
    const rows = await this.prisma.submission.findMany({
      where: { competitionId: comp.id },
      orderBy: { submittedAt: 'desc' },
      take: 10_000,
      select: {
        id: true,
        isCorrect: true,
        submittedAt: true,
        user: { select: { username: true, displayName: true } },
        team: { select: { name: true } },
        challenge: { select: { slug: true, title: true } },
      },
    });

    // Strictly omits submittedHash, flag secrets, password hashes, emails, and raw IP
    const csv = buildRfc4180Csv(
      ['SubmissionID', 'SubmittedAt', 'Username', 'DisplayName', 'TeamName', 'ChallengeSlug', 'ChallengeTitle', 'Result'],
      rows.map((r) => [
        r.id,
        r.submittedAt,
        r.user.username,
        r.user.displayName,
        r.team?.name ?? '',
        r.challenge.slug,
        r.challenge.title,
        r.isCorrect ? 'CORRECT' : 'INCORRECT',
      ]),
    );

    await this.audit.record({
      actorId: auth.userId,
      category: 'MODERATION',
      action: 'ANALYTICS_CSV_EXPORTED',
      entityType: 'Competition',
      entityId: comp.id,
      metadata: { exportType: 'SUBMISSIONS_SUMMARY', rowCount: rows.length },
      correlationId: meta.correlationId,
      ipAddress: meta.ipAddress,
    });

    return {
      filename: sanitizeCsvFilename(comp.slug, 'submissions'),
      csv,
    };
  }
}

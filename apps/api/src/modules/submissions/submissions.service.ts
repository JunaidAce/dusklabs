import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import { sha256Hex } from '../../utils/crypto.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
} from '../../utils/errors.js';
import { type FlagCryptoConfig, verifyCandidateFlag } from '../../utils/flagCrypto.js';
import type { ScoringService } from '../scoring/scoring.service.js';
import type { AchievementsService } from '../achievements/achievements.service.js';
import type { AuditService } from '../audit/audit.service.js';

function isPrismaRaceOrUniqueError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (code === 'P2002' || code === 'P2034') return true;
  const msg = (err as { message?: string }).message ?? '';
  return msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_BUSY');
}

export class SubmissionsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly flagCrypto: FlagCryptoConfig,
    private readonly scoringService: ScoringService,
    private readonly achievements?: AchievementsService,
  ) {}

  private async resolveEligibility(
    auth: AuthenticatedContext,
    challenge: {
      id: string;
      status: string;
      isVisible: boolean;
      authorId: string | null;
      createdById: string | null;
      competitionId: string | null;
    },
  ): Promise<{ competitionId: string | null; teamId: string | null }> {
    if (challenge.status !== 'PUBLISHED' || !challenge.isVisible) {
      throw new NotFoundError('Challenge not found');
    }

    if (challenge.authorId === auth.userId || challenge.createdById === auth.userId) {
      throw new ForbiddenError(
        'Challenge authors cannot submit flags for their own challenges',
        'AUTHOR_CANNOT_SOLVE',
      );
    }

    if (!challenge.competitionId) {
      return { competitionId: null, teamId: null };
    }

    const comp = await this.prisma.competition.findUnique({
      where: { id: challenge.competitionId },
    });
    if (!comp) {
      throw new NotFoundError('Associated competition not found');
    }

    const now = Date.now();
    if (
      comp.status !== 'LIVE' ||
      now < comp.startsAt.getTime() ||
      now > comp.endsAt.getTime()
    ) {
      throw new ForbiddenError(
        'Submissions are only accepted while the competition is LIVE',
        'COMPETITION_NOT_LIVE',
      );
    }

    // Check individual disqualification if registration row exists
    const userReg = await this.prisma.competitionRegistration.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: auth.userId } },
    });
    if (userReg && userReg.status === 'DISQUALIFIED') {
      throw new ForbiddenError('Your registration is disqualified', 'DISQUALIFIED');
    }

    const activeTeamMembership = await this.prisma.teamMember.findFirst({
      where: {
        userId: auth.userId,
        team: {
          deletedAt: null,
          competitions: { some: { competitionId: comp.id, status: 'CONFIRMED' } },
        },
      },
      select: { teamId: true },
    });

    if (comp.participationMode === 'TEAM') {
      if (!activeTeamMembership) {
        throw new ForbiddenError(
          'An officially registered team is required for this competition',
          'COMPETITION_NOT_REGISTERED',
        );
      }
      return { competitionId: comp.id, teamId: activeTeamMembership.teamId };
    }

    if (comp.participationMode === 'INDIVIDUAL') {
      if (!userReg || userReg.status !== 'CONFIRMED') {
        throw new ForbiddenError(
          'Competition registration is required before submitting flags',
          'COMPETITION_NOT_REGISTERED',
        );
      }
      return { competitionId: comp.id, teamId: null };
    }

    // HYBRID mode: team if registered on a team, else confirmed individual registration
    if (activeTeamMembership) {
      return { competitionId: comp.id, teamId: activeTeamMembership.teamId };
    }
    if (userReg && userReg.status === 'CONFIRMED') {
      return { competitionId: comp.id, teamId: null };
    }

    throw new ForbiddenError(
      'Competition registration is required before submitting flags',
      'COMPETITION_NOT_REGISTERED',
    );
  }

  async submitFlag(
    auth: AuthenticatedContext,
    idOrSlug: string,
    candidateFlag: string,
    ipAddress?: string,
  ) {
    const challenge = await this.prisma.challenge.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: { flagConfiguration: true },
    });

    if (!challenge) {
      throw new NotFoundError('Challenge not found');
    }

    const { competitionId, teamId } = await this.resolveEligibility(auth, challenge);

    if (!challenge.flagConfiguration) {
      throw new BadRequestError('Challenge flag is not configured');
    }

    const scopeWhere = teamId
      ? { challengeId: challenge.id, OR: [{ userId: auth.userId }, { teamId }] }
      : { challengeId: challenge.id, userId: auth.userId };

    // Pre-check existing solve
    const existingSolve = await this.prisma.solve.findFirst({ where: scopeWhere });
    if (existingSolve) {
      throw new ConflictError('Challenge has already been solved', 'ALREADY_SOLVED');
    }

    // Enforce maxAttempts if configured (> 0)
    const usedAttempts = await this.prisma.submission.count({ where: scopeWhere });
    if (challenge.maxAttempts > 0 && usedAttempts >= challenge.maxAttempts) {
      throw new TooManyRequestsError(
        `Maximum attempt limit (${challenge.maxAttempts}) reached for this challenge`,
        'ATTEMPT_LIMIT_EXCEEDED',
      );
    }

    const participantKey = teamId ?? auth.userId;
    const isCorrect = verifyCandidateFlag({
      stored: challenge.flagConfiguration,
      candidateFlag,
      challengeId: challenge.id,
      participantKey,
      cfg: this.flagCrypto,
    });

    const submittedHash = sha256Hex(candidateFlag.trim());
    await this.prisma.submission.create({
      data: {
        challengeId: challenge.id,
        competitionId,
        userId: auth.userId,
        teamId,
        submittedHash,
        isCorrect,
        ipAddress: ipAddress ?? null,
      },
    });

    const nextAttemptsUsed = usedAttempts + 1;
    const remainingAttempts =
      challenge.maxAttempts > 0 ? Math.max(0, challenge.maxAttempts - nextAttemptsUsed) : null;

    if (!isCorrect) {
      return {
        correct: false,
        status: 'INCORRECT' as const,
        message: 'Incorrect flag',
        remainingAttempts,
      };
    }

    // Atomic solve & dynamic scoring delegated to ScoringService
    let solveResult: {
      solveId: string;
      pointsAwarded: number;
      firstBloodBonusAwarded: number;
      isFirstBlood: boolean;
    };

    const competitionRow = competitionId
      ? await this.prisma.competition.findUnique({
          where: { id: competitionId },
          select: {
            id: true,
            scoringMode: true,
            dynamicScoringPolicy: true,
            firstBloodEnabled: true,
          },
        })
      : null;

    try {
      solveResult = await this.prisma.$transaction((tx) =>
        this.scoringService.recordValidatedSolve(tx, {
          challenge,
          competition: competitionRow,
          userId: auth.userId,
          teamId,
        }),
      );
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      if (isPrismaRaceOrUniqueError(err)) {
        throw new ConflictError('Challenge has already been solved', 'ALREADY_SOLVED');
      }
      throw err;
    }

    await this.audit.record({
      actorId: auth.userId,
      action: 'CHALLENGE_SOLVED',
      entityType: 'Solve',
      entityId: solveResult.solveId,
      metadata: {
        challengeId: challenge.id,
        competitionId,
        teamId,
        pointsAwarded: solveResult.pointsAwarded,
        isFirstBlood: solveResult.isFirstBlood,
      },
      ipAddress,
    });

    await this.achievements?.evaluateAfterSolve({
      userId: auth.userId,
      teamId,
      challengeId: challenge.id,
      competitionId,
      isFirstBlood: solveResult.isFirstBlood,
    });

    return {
      correct: true,
      status: 'SOLVED' as const,
      message: solveResult.isFirstBlood
        ? 'First Blood! Flag verified and points awarded.'
        : 'Flag verified and points awarded.',
      pointsAwarded: solveResult.pointsAwarded,
      firstBloodBonusAwarded: solveResult.firstBloodBonusAwarded,
      totalAwarded: solveResult.pointsAwarded + solveResult.firstBloodBonusAwarded,
      isFirstBlood: solveResult.isFirstBlood,
      remainingAttempts,
    };
  }
}

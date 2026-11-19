import type { PrismaClient } from '@prisma/client';
import type { CompetitionsService } from './competitions.service.js';

export class CompetitionLifecycleScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly competitionsService: CompetitionsService,
    private readonly logError: (err: unknown, msg: string) => void,
  ) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processScheduledTransitions(new Date());
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async processScheduledTransitions(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let transitionsApplied = 0;

    try {
      const activeComps = await this.prisma.competition.findMany({
        where: {
          status: { in: ['SCHEDULED', 'REGISTRATION_OPEN', 'UPCOMING', 'LIVE', 'PAUSED'] },
        },
        select: {
          id: true,
          status: true,
          registrationOpenAt: true,
          registrationCloseAt: true,
          startsAt: true,
          endsAt: true,
        },
      });

      const nowMs = now.getTime();
      for (const comp of activeComps) {
        const regOpenMs = comp.registrationOpenAt?.getTime() ?? null;
        const regCloseMs = comp.registrationCloseAt?.getTime() ?? comp.startsAt.getTime();
        const startMs = comp.startsAt.getTime();
        const endMs = comp.endsAt.getTime();

        try {
          if (
            comp.status === 'SCHEDULED' &&
            regOpenMs !== null &&
            nowMs >= regOpenMs &&
            nowMs < regCloseMs
          ) {
            await this.competitionsService.executeLifecycleTransition({
              competitionId: comp.id,
              targetStatus: 'REGISTRATION_OPEN',
              actorId: null,
              reason: 'Scheduled registration window opened',
              now,
            });
            transitionsApplied++;
          } else if (comp.status === 'REGISTRATION_OPEN' && nowMs >= regCloseMs) {
            await this.competitionsService.executeLifecycleTransition({
              competitionId: comp.id,
              targetStatus: 'UPCOMING',
              actorId: null,
              reason: 'Scheduled registration window closed',
              now,
            });
            transitionsApplied++;
          } else if (comp.status === 'UPCOMING' && nowMs >= startMs && nowMs < endMs) {
            await this.competitionsService.executeLifecycleTransition({
              competitionId: comp.id,
              targetStatus: 'LIVE',
              actorId: null,
              reason: 'Scheduled competition start time reached',
              now,
            });
            transitionsApplied++;
          } else if ((comp.status === 'LIVE' || comp.status === 'PAUSED') && nowMs >= endMs) {
            await this.competitionsService.executeLifecycleTransition({
              competitionId: comp.id,
              targetStatus: 'COMPLETED',
              actorId: null,
              reason: 'Scheduled competition end time reached',
              now,
            });
            transitionsApplied++;
          }
        } catch (err) {
          this.logError(err, `Scheduler failed transitioning competition ${comp.id}`);
        }
      }
    } finally {
      this.running = false;
    }

    return transitionsApplied;
  }
}

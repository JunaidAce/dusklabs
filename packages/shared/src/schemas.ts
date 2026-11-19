import { z } from 'zod';
import {
  ChallengeStatuses,
  ChallengeTypes,
  CompetitionStatuses,
  Difficulties,
  FlagTypes,
  ParticipationModes,
  ReportCategories,
  ReportStatuses,
  ScoringModes,
  DynamicScoringPolicies,
  RoleNames,
  ContactCategories,
  ContactStatuses,
  AuditCategories,
  AchievementTiers,
} from './enums.js';

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const usernameRegex = /^[a-zA-Z0-9_]{3,24}$/;

// [330; VULN-01 guard]
export const httpUrlSchema = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((val) => {
    try {
      const parsed = new URL(val);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'URL must use http:// or https:// protocol');

// [12]
export const registerSchema = z.object({
  username: z.string().regex(usernameRegex, 'Username must be 3-24 alphanumeric or underscore characters'),
  displayName: z.string().trim().min(2).max(48),
  email: z.string().trim().email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(12, 'Password must be at least 12 characters').max(128),
  country: z.string().trim().length(2).toUpperCase().optional(),
  registrationCode: z.string().trim().min(1).max(64).optional(),
});

// [12]
export const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
});

// [12]
export const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(254).transform((v) => v.toLowerCase()),
});

// [12]
export const resetPasswordSchema = z.object({
  token: z.string().min(32).max(256),
  newPassword: z.string().min(12).max(128),
});

// [12; VULN-01: logoUrl uses httpUrlSchema]
export const createTeamSchema = z.object({
  name: z.string().trim().min(2).max(40),
  bio: z.string().trim().max(300).optional(),
  logoUrl: httpUrlSchema.optional(),
});

// [195 — supersedes [12] competition schemas]
function isValidIanaTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const competitionBaseSchema = z.object({
  slug: z.string().regex(slugRegex, 'Slug must be lowercase alphanumeric with hyphens').min(3).max(64),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(10000),
  rules: z.string().trim().min(10).max(15000),
  bannerUrl: httpUrlSchema
    .nullable()
    .optional(),
  isVisible: z.boolean().default(false),
  timezone: z.string().trim().min(1).max(64).refine(isValidIanaTimezone, 'Invalid IANA timezone').default('UTC'),
  participationMode: z.enum(ParticipationModes),
  minTeamSize: z.number().int().min(1).max(20).default(1),
  maxTeamSize: z.number().int().min(1).max(20).default(4),
  lockTeamRosterOnLive: z.boolean().default(true),
  scoringMode: z.enum(ScoringModes).default('DYNAMIC'),
  dynamicScoringPolicy: z.enum(DynamicScoringPolicies).default('RETROACTIVE'),
  allowNegativeScores: z.boolean().default(false),
  firstBloodEnabled: z.boolean().default(true),
  registrationOpenAt: z.string().datetime().nullable().optional(),
  registrationCloseAt: z.string().datetime().nullable().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

// [195]
export const createCompetitionSchema = competitionBaseSchema.superRefine((data, ctx) => {
  if (data.maxTeamSize < data.minTeamSize) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxTeamSize'],
      message: 'maxTeamSize must be greater than or equal to minTeamSize',
    });
  }
  const start = new Date(data.startsAt).getTime();
  const end = new Date(data.endsAt).getTime();
  if (end <= start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'endsAt must be after startsAt',
    });
  }
  if (data.registrationOpenAt && data.registrationCloseAt) {
    const regOpen = new Date(data.registrationOpenAt).getTime();
    const regClose = new Date(data.registrationCloseAt).getTime();
    if (regClose <= regOpen) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['registrationCloseAt'],
        message: 'registrationCloseAt must be after registrationOpenAt',
      });
    }
    if (regClose > end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['registrationCloseAt'],
        message: 'registrationCloseAt cannot be after endsAt',
      });
    }
  }
});

// [195]
export const updateCompetitionSchema = competitionBaseSchema.partial();

// [195]
export const assignOrganizerSchema = z.object({
  userId: z.string().cuid(),
});

// [12]
export const configureFlagSchema = z.object({
  flagType: z.enum(FlagTypes),
  flagValue: z.string().trim().min(4).max(256),
  dynamicPattern: z.string().trim().max(256).optional(),
});

// [12]
export const submitFlagSchema = z.object({
  flag: z.string().trim().min(1).max(256),
});

// [12]
export const adjustScoreSchema = z.object({
  userId: z.string().cuid(),
  teamId: z.string().cuid().nullable().optional(),
  competitionId: z.string().cuid().nullable().optional(),
  deltaPoints: z.number().int().min(-10000).max(10000).refine((v) => v !== 0, 'Delta cannot be zero'),
  reason: z.string().trim().min(5).max(300),
});

// [85; VULN-01: logoUrl uses httpUrlSchema]
export const updateTeamSchema = z.object({
  name: z.string().trim().min(2).max(40).optional(),
  bio: z.string().trim().max(300).nullable().optional(),
  logoUrl: httpUrlSchema.nullable().optional(),
});

// [85]
export const inviteMemberSchema = z
  .object({
    username: z.string().trim().min(3).max(24).optional(),
    email: z.string().trim().email().max(254).transform((v) => v.toLowerCase()).optional(),
    message: z.string().trim().max(200).optional(),
  })
  .refine((v) => Boolean(v.username || v.email), {
    message: 'Provide either a username or email address',
  });

// [85]
export const joinByCodeSchema = z.object({
  inviteCode: z.string().trim().min(6).max(64),
});

// [85]
export const joinRequestSchema = z.object({
  message: z.string().trim().max(200).optional(),
});

// [85]
export const respondInvitationSchema = z.object({
  action: z.enum(['ACCEPT', 'DECLINE']),
});

// [85]
export const transferCaptainSchema = z.object({
  newCaptainUserId: z.string().cuid(),
});

// [108]
export const createChallengeSchema = z.object({
  slug: z.string().regex(slugRegex).min(2).max(64),
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().min(10).max(20000),
  connectionInfo: z.string().trim().max(1000).nullable().optional(),
  difficulty: z.enum(Difficulties),
  challengeType: z.enum(ChallengeTypes).default('JEOPARDY_FILE'),
  status: z.enum(ChallengeStatuses).default('DRAFT'),
  isVisible: z.boolean().default(false),
  scoringMode: z.enum(ScoringModes).default('STATIC'),
  points: z.number().int().min(10).max(10000),
  initialPoints: z.number().int().min(10).max(10000),
  minPoints: z.number().int().min(10).max(10000).default(50),
  decayRate: z.number().int().min(1).max(1000).default(20),
  firstBloodBonus: z.number().int().min(0).max(2000).default(0),
  maxAttempts: z.number().int().min(0).max(1000).default(0),
  competitionId: z.string().cuid().nullable().optional(),
  authorId: z.string().cuid().nullable().optional(),
  categoryIds: z.array(z.string().cuid()).min(1).max(3),
  tags: z.array(z.string().trim().min(1).max(32)).max(10).default([]),
  flagConfig: configureFlagSchema.optional(),
});

// [108]
export const createCategorySchema = z.object({
  slug: z.string().regex(slugRegex).min(2).max(48),
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  sortOrder: z.number().int().min(0).max(999).default(0),
});

// [108]
export const updateCategorySchema = createCategorySchema.partial();

// [108]
export const updateChallengeSchema = createChallengeSchema
  .omit({ status: true, flagConfig: true })
  .partial();

// [108]
export const transitionChallengeSchema = z.object({
  targetStatus: z.enum(ChallengeStatuses),
});

// [108]
export const testFlagSchema = z.object({
  candidateFlag: z.string().trim().min(1).max(256),
  participantKey: z.string().trim().min(1).max(64).optional(),
});

// [159]
export const createHintSchema = z.object({
  sortOrder: z.number().int().min(1).max(20).optional(),
  title: z.string().trim().min(2).max(80),
  content: z.string().trim().min(2).max(4000),
  costPoints: z.number().int().min(0).max(5000).default(0),
  isAvailable: z.boolean().default(true),
  requiresPreviousHint: z.boolean().default(false),
});

// [159]
export const updateHintSchema = createHintSchema.partial();

// [159]
export const reorderHintsSchema = z.object({
  hintIds: z.array(z.string().cuid()).min(1).max(50),
});

// [202]
export const transitionCompetitionSchema = z.object({
  targetStatus: z.enum(CompetitionStatuses),
  reason: z.string().trim().min(3).max(300).optional(),
});

// [220]
export const teamRegistrationSchema = z.object({
  teamId: z.string().cuid(),
});

// [220]
export const manageRegistrationSchema = z.object({
  status: z.enum(['CONFIRMED', 'DISQUALIFIED']),
  reason: z.string().trim().min(3).max(300).optional(),
});

// [240]
export const createAnnouncementSchema = z.object({
  title: z.string().trim().min(3).max(140),
  body: z.string().trim().min(5).max(10000),
  isPinned: z.boolean().default(false),
});

// [240]
export const updateAnnouncementSchema = createAnnouncementSchema.partial();

// [285]
export const suspendUserSchema = z.object({
  reason: z.string().trim().min(5, 'Reason must be at least 5 characters').max(500),
  expiresAt: z.string().datetime().nullable().optional(),
});

// [285]
export const banUserSchema = z.object({
  reason: z.string().trim().min(5, 'Reason must be at least 5 characters').max(500),
});

// [285]
export const restoreUserSchema = z.object({
  reason: z.string().trim().min(5, 'Reason must be at least 5 characters').max(500),
});

// [285]
export const assignRoleSchema = z.object({
  roleName: z.enum(RoleNames),
});

// [disk: contact module (c62-era), complete on disk]
export const createContactInquirySchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  email: z.string().trim().email('Valid email address required').max(254).transform((v) => v.toLowerCase()),
  category: z.enum(ContactCategories),
  subject: z.string().trim().min(4, 'Subject must be at least 4 characters').max(140),
  message: z.string().trim().min(15, 'Message must be at least 15 characters').max(4000),
  website: z.string().max(100).optional(), // Optional anti-spam honeypot
});

// [297]
export const createReportSchema = z.object({
  competitionId: z.string().cuid().optional(),
  challengeId: z.string().cuid().optional(),
  targetUserId: z.string().cuid().optional(),
  submissionId: z.string().cuid().optional(),
  category: z.enum(ReportCategories),
  description: z.string().trim().min(10).max(3000),
  isAnonymous: z.boolean().default(false),
});

// [297]
export const updateContactInquirySchema = z.object({
  status: z.enum(ContactStatuses),
  assignedAdminId: z.string().cuid().nullable().optional(),
  adminNotes: z.string().trim().max(2000).nullable().optional(),
});

// [297]
export const moderateReportSchema = z.object({
  status: z.enum(ReportStatuses).optional(),
  assignedModeratorId: z.string().cuid().nullable().optional(),
  internalNotes: z.string().trim().max(2000).nullable().optional(),
  resolution: z.string().trim().min(5).max(1000).optional(),
});

// [297]
export const resolveDisputeSchema = z
  .object({
    action: z.enum(['CREDIT_POINTS', 'REVOKE_POINTS', 'UPHOLD_ORIGINAL']),
    deltaPoints: z.number().int().min(1).max(10000).optional(),
    reason: z.string().trim().min(5, 'Audit reason required').max(500),
  })
  .refine(
    (v) => v.action === 'UPHOLD_ORIGINAL' || (typeof v.deltaPoints === 'number' && v.deltaPoints > 0),
    { message: 'deltaPoints is required when crediting or revoking points' },
  );

// [320]
export const updatePlatformSettingsSchema = z.object({
  platformName: z.string().trim().min(2).max(60).optional(),
  tagline: z.string().trim().min(4).max(140).optional(),
  registrationEnabled: z.boolean().optional(),
  registrationCode: z.string().trim().min(8).max(64).nullable().optional(),
  requireEmailVerificationForLogin: z.boolean().optional(),
  teamCreationEnabled: z.boolean().optional(),
  defaultMaxTeamSize: z.number().int().min(1).max(50).optional(),
  flagSubmissionMaxAttemptsPerMin: z.number().int().min(1).max(120).optional(),
  maintenanceMode: z.boolean().optional(),
  maintenanceMessage: z.string().trim().max(500).nullable().optional(),
  contactFormEnabled: z.boolean().optional(),
  scoreboardVisible: z.boolean().optional(),
  challengesVisible: z.boolean().optional(),
});

// [330 — definition moved above createTeamSchema for TDZ; see top of file]

// [disk: c56 achievements, complete on disk]
export const createAchievementSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_]{3,48}$/),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().min(5).max(300),
  ruleType: z.string().trim().min(3).max(64),
  threshold: z.number().int().min(1).max(10000).default(1),
  tier: z.enum(AchievementTiers).default('BRONZE'),
  iconKey: z.string().trim().min(2).max(32).default('HEX_CORE'),
  isActive: z.boolean().default(true),
});

// [disk: c56 achievements]
export const updateAchievementSchema = createAchievementSchema
  .omit({ code: true })
  .partial();

// [disk: c56 achievements]
export const updatePrivacySchema = z.object({
  showAchievementsOnProfile: z.boolean(),
});

// [disk: c68/c74 audit, complete on disk]
export const auditQuerySchema = z
  .object({
    actor: z.string().trim().max(64).optional(),
    category: z.enum(AuditCategories).optional(),
    action: z.string().trim().max(80).optional(),
    entityType: z.string().trim().max(64).optional(),
    entityId: z.string().trim().max(64).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .superRefine((data, ctx) => {
    if (data.startDate && data.endDate) {
      if (new Date(data.endDate).getTime() < new Date(data.startDate).getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endDate'],
          message: 'endDate must be greater than or equal to startDate',
        });
      }
    }
  });

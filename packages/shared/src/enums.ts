export const RoleNames = [
  'SUPER_ADMIN',
  'PLATFORM_ADMIN',
  'COMPETITION_ORGANIZER',
  'CHALLENGE_AUTHOR',
  'MODERATOR',
  'TEAM_CAPTAIN',
  'PARTICIPANT',
] as const;
export type RoleName = (typeof RoleNames)[number];

export const PermissionKeys = [
  'platform:settings:manage',
  'admin:roles:assign',
  'audit:logs:read',
  'user:manage',
  'category:manage',
  'competition:create',
  'competition:manage',
  'competition:transition',
  'announcement:publish',
  'challenge:create',
  'challenge:edit',
  'challenge:publish',
  'challenge:flag:configure',
  'submission:inspect',
  'score:adjust',
  'report:moderate',
  'achievement:manage',
  'analytics:export',
  'team:manage:own',
  'arena:participate',
  'report:submit',
] as const;
export type PermissionKey = (typeof PermissionKeys)[number];

export const ROLE_PERMISSION_MAP: Record<RoleName, readonly PermissionKey[]> = {
  SUPER_ADMIN: [...PermissionKeys],
  PLATFORM_ADMIN: [
    'admin:roles:assign',
    'audit:logs:read',
    'user:manage',
    'category:manage',
    'competition:create',
    'competition:manage',
    'competition:transition',
    'announcement:publish',
    'challenge:create',
    'challenge:edit',
    'challenge:publish',
    'challenge:flag:configure',
    'submission:inspect',
    'score:adjust',
    'report:moderate',
    'achievement:manage',
    'analytics:export',
    'team:manage:own',
    'arena:participate',
    'report:submit',
  ],
  COMPETITION_ORGANIZER: [
    'competition:create',
    'competition:manage',
    'competition:transition',
    'announcement:publish',
    'challenge:create',
    'challenge:edit',
    'challenge:publish',
    'challenge:flag:configure',
    'submission:inspect',
    'score:adjust',
    'report:moderate',
    'achievement:manage',
    'analytics:export',
    'team:manage:own',
    'arena:participate',
    'report:submit',
  ],
  CHALLENGE_AUTHOR: [
    'challenge:create',
    'challenge:edit',
    'challenge:publish',
    'challenge:flag:configure',
    'team:manage:own',
    'arena:participate',
    'report:submit',
  ],
  MODERATOR: [
    'audit:logs:read',
    'user:manage',
    'submission:inspect',
    'report:moderate',
    'team:manage:own',
    'arena:participate',
    'report:submit',
  ],
  TEAM_CAPTAIN: [
    'team:manage:own',
    'arena:participate',
    'report:submit',
  ],
  PARTICIPANT: [
    'arena:participate',
    'report:submit',
  ],
};

export const AccountStatuses = ['ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED'] as const;
export type AccountStatus = (typeof AccountStatuses)[number];

export const CompetitionStatuses = [
  'DRAFT',
  'SCHEDULED',
  'REGISTRATION_OPEN',
  'UPCOMING',
  'LIVE',
  'PAUSED',
  'COMPLETED',
  'ARCHIVED',
] as const;
export type CompetitionStatus = (typeof CompetitionStatuses)[number];

export const ParticipationModes = ['INDIVIDUAL', 'TEAM', 'HYBRID'] as const;
export type ParticipationMode = (typeof ParticipationModes)[number];

export const ScoringModes = ['STATIC', 'DYNAMIC'] as const;
export type ScoringMode = (typeof ScoringModes)[number];

// [194]
export const DynamicScoringPolicies = ['RETROACTIVE', 'LOCK_AT_SOLVE'] as const;
export type DynamicScoringPolicy = (typeof DynamicScoringPolicies)[number];

export const ChallengeStatuses = ['DRAFT', 'TESTING', 'PUBLISHED', 'ARCHIVED'] as const;
export type ChallengeStatus = (typeof ChallengeStatuses)[number];

export const Difficulties = ['BEGINNER', 'EASY', 'MEDIUM', 'HARD', 'EXPERT'] as const;
export type Difficulty = (typeof Difficulties)[number];

export const ChallengeTypes = ['JEOPARDY_FILE', 'JEOPARDY_TEXT', 'JEOPARDY_CRYPTO', 'JEOPARDY_FORENSICS'] as const;
export type ChallengeType = (typeof ChallengeTypes)[number];

export const FlagTypes = ['STATIC_EXACT', 'STATIC_CASE_INSENSITIVE', 'DYNAMIC_HMAC_PATTERN'] as const;
export type FlagType = (typeof FlagTypes)[number];

export const ScoreTransactionTypes = [
  'SOLVE',
  'FIRST_BLOOD',
  'HINT_PENALTY',
  'DYNAMIC_RECALC',
  'MANUAL_ADJUSTMENT',
] as const;
export type ScoreTransactionType = (typeof ScoreTransactionTypes)[number];

export const ReportCategories = ['BUG', 'DISPUTE', 'CHEATING', 'ABUSE'] as const;
export type ReportCategory = (typeof ReportCategories)[number];

export const ReportStatuses = ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'] as const;
export type ReportStatus = (typeof ReportStatuses)[number];

export const NotificationTypes = [
  'COMP_REG',
  'COMP_LIVE',
  'COMP_END',
  'TEAM_INVITE',
  'TEAM_UPDATE',
  'SOLVE',
  'ANNOUNCEMENT',
  'ACHIEVEMENT',
] as const;
export type NotificationType = (typeof NotificationTypes)[number];

export const TeamInvitationTypes = ['INVITE', 'REQUEST'] as const;
export type TeamInvitationType = (typeof TeamInvitationTypes)[number];

export const TeamInvitationStatuses = ['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED'] as const;
export type TeamInvitationStatus = (typeof TeamInvitationStatuses)[number];

export const AchievementTiers = ['BRONZE', 'SILVER', 'GOLD', 'APEX'] as const;
export type AchievementTier = (typeof AchievementTiers)[number];

export const ContactCategories = [
  'GENERAL',
  'COMPETITION',
  'SECURITY_DISCLOSURE',
  'ACCOUNT_SUPPORT',
  'PARTNERSHIP',
] as const;
export type ContactCategory = (typeof ContactCategories)[number];

export const ContactStatuses = ['OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED'] as const;
export type ContactStatus = (typeof ContactStatuses)[number];

export const AuditCategories = [
  'AUTH',
  'USER_ADMIN',
  'COMPETITION',
  'CHALLENGE',
  'SCORING',
  'MODERATION',
  'TEAM',
  'ACHIEVEMENT',
  'SYSTEM',
] as const;
export type AuditCategory = (typeof AuditCategories)[number];

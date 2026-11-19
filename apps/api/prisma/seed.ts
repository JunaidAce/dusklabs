import { PrismaClient } from '@prisma/client';
import {
  PermissionKeys,
  ROLE_PERMISSION_MAP,
  RoleNames,
  type RoleName,
} from '@dusklabs/shared';

const prisma = new PrismaClient();

const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  SUPER_ADMIN: 'Complete platform authority, settings, and administrator management',
  PLATFORM_ADMIN: 'Manage users, categories, challenges, competitions, and analytics',
  COMPETITION_ORGANIZER: 'Create and manage competitions, schedules, challenges, and announcements',
  CHALLENGE_AUTHOR: 'Author, test, and publish assigned Jeopardy challenges and attachments',
  MODERATOR: 'Review incident reports, suspicious submissions, and enforce account bans',
  TEAM_CAPTAIN: 'Manage team membership, invitations, and roster details',
  PARTICIPANT: 'Compete in competitions, solve challenges, submit flags, and join teams',
};

const CATEGORIES = [
  { slug: 'web-exploitation', name: 'Web Exploitation', sortOrder: 1, description: 'HTTP, auth bypass, injection, SSRF, and client/server web security' },
  { slug: 'cryptography', name: 'Cryptography', sortOrder: 2, description: 'Classical, symmetric, asymmetric, and protocol cryptanalysis' },
  { slug: 'digital-forensics', name: 'Digital Forensics', sortOrder: 3, description: 'Packet captures, disk/memory images, file carving, and metadata analysis' },
  { slug: 'osint', name: 'OSINT', sortOrder: 4, description: 'Open-source intelligence gathering and attribution' },
  { slug: 'reverse-engineering', name: 'Reverse Engineering', sortOrder: 5, description: 'Static and dynamic analysis of compiled binaries and bytecode' },
  { slug: 'binary-exploitation', name: 'Binary Exploitation', sortOrder: 6, description: 'Memory corruption, ROP, heap exploitation, and binary analysis' },
  { slug: 'miscellaneous', name: 'Miscellaneous', sortOrder: 7, description: 'Scripting, encodings, esolangs, and cross-domain puzzles' },
  { slug: 'network-security', name: 'Network Security', sortOrder: 8, description: 'Protocol inspection, traffic analysis, and routing security' },
  { slug: 'ai-and-machine-learning', name: 'AI and Machine Learning', sortOrder: 9, description: 'Model extraction, adversarial inputs, and prompt/ML security' },
];

const ACHIEVEMENTS = [
  { code: 'FIRST_BLOOD', name: 'First Blood', description: 'First valid solve of any challenge', ruleType: 'FIRST_BLOOD', threshold: 1, tier: 'GOLD', iconKey: 'HEX_BLOOD' },
  { code: 'FIRST_SOLVE', name: 'First Solve', description: 'Solve your first challenge on DuskLabs', ruleType: 'TOTAL_SOLVES', threshold: 1, tier: 'BRONZE', iconKey: 'HEX_SPARK' },
  { code: 'FIVE_SOLVES', name: 'Five Solves', description: 'Solve 5 distinct challenges', ruleType: 'TOTAL_SOLVES', threshold: 5, tier: 'BRONZE', iconKey: 'HEX_CORE' },
  { code: 'TEN_SOLVES', name: 'Ten Solves', description: 'Solve 10 distinct challenges', ruleType: 'TOTAL_SOLVES', threshold: 10, tier: 'SILVER', iconKey: 'HEX_CORE' },
  { code: 'TWENTY_FIVE_SOLVES', name: 'Quarter Century', description: 'Solve 25 distinct challenges', ruleType: 'TOTAL_SOLVES', threshold: 25, tier: 'SILVER', iconKey: 'HEX_SHIELD' },
  { code: 'FIFTY_SOLVES', name: 'Fifty Solves', description: 'Solve 50 distinct challenges', ruleType: 'TOTAL_SOLVES', threshold: 50, tier: 'GOLD', iconKey: 'HEX_SHIELD' },
  { code: 'HUNDRED_SOLVES', name: 'Centurion', description: 'Solve 100 distinct challenges', ruleType: 'TOTAL_SOLVES', threshold: 100, tier: 'APEX', iconKey: 'HEX_CROWN' },
  { code: 'WEB_SPECIALIST', name: 'Web Specialist', description: 'Solve 3 Web Exploitation challenges', ruleType: 'CATEGORY_SOLVES:web-exploitation', threshold: 3, tier: 'SILVER', iconKey: 'HEX_WEB' },
  { code: 'CRYPTO_EXPLORER', name: 'Cryptography Explorer', description: 'Solve 3 Cryptography challenges', ruleType: 'CATEGORY_SOLVES:cryptography', threshold: 3, tier: 'SILVER', iconKey: 'HEX_CRYPTO' },
  { code: 'FORENSICS_INVESTIGATOR', name: 'Forensics Investigator', description: 'Solve 3 Digital Forensics challenges', ruleType: 'CATEGORY_SOLVES:digital-forensics', threshold: 3, tier: 'SILVER', iconKey: 'HEX_FORENSICS' },
  { code: 'COMPETITION_PARTICIPANT', name: 'Competition Participant', description: 'Participate in a DuskLabs competition', ruleType: 'COMPETITION_PARTICIPATION', threshold: 1, tier: 'BRONZE', iconKey: 'HEX_COMP' },
  { code: 'COMPETITION_CHAMPION', name: 'Competition Champion', description: 'Finish Rank #1 in a completed competition', ruleType: 'COMPETITION_CHAMPION', threshold: 1, tier: 'APEX', iconKey: 'HEX_CROWN' },
];

async function main() {
  for (const key of PermissionKeys) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: `Permission ${key}` },
    });
  }

  const allPerms = await prisma.permission.findMany();
  const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));

  for (const roleName of RoleNames) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      update: { description: ROLE_DESCRIPTIONS[roleName] },
      create: {
        name: roleName,
        description: ROLE_DESCRIPTIONS[roleName],
        isSystem: true,
      },
    });

    for (const permKey of ROLE_PERMISSION_MAP[roleName]) {
      const permissionId = permByKey.get(permKey);
      if (!permissionId) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
  }

  for (const cat of CATEGORIES) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      update: { name: cat.name, description: cat.description, sortOrder: cat.sortOrder },
      create: cat,
    });
  }

  for (const ach of ACHIEVEMENTS) {
    await prisma.achievement.upsert({
      where: { code: ach.code },
      update: { name: ach.name, description: ach.description, ruleType: ach.ruleType, threshold: ach.threshold },
      create: ach,
    });
  }

  await prisma.platformSettings.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default' },
  });

  console.log('Seeded roles, permissions, 9 categories, 12 achievements, and default platform settings.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

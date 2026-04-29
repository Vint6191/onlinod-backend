generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserRole {
  OWNER
  ADMIN
  MANAGER
  OPERATOR
}

enum CreatorStatus {
  DRAFT
  READY
  NOT_CREATOR
  AUTH_FAILED
  DISABLED
}

enum AuthTokenType {
  EMAIL_VERIFY
  PASSWORD_RESET
}

model User {
  id              String    @id @default(cuid())
  email           String    @unique
  passwordHash    String
  name            String?
  avatarUrl       String?
  emailVerifiedAt DateTime?
  lastLoginAt     DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  memberships     AgencyMember[]
  authTokens      AuthToken[]
  refreshSessions RefreshSession[]
}

model Agency {
  id        String   @id @default(cuid())
  name      String
  plan      String   @default("dev")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  members  AgencyMember[]
  creators CreatorAccount[]
}

model AgencyMember {
  id          String   @id @default(cuid())
  agencyId    String
  userId      String
  role        UserRole @default(OWNER)
  permissions Json?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  agency Agency @relation(fields: [agencyId], references: [id], onDelete: Cascade)
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([agencyId, userId])
  @@index([agencyId])
  @@index([userId])
}

model CreatorAccount {
  id          String        @id @default(cuid())
  agencyId    String
  displayName String
  username    String?
  avatarUrl   String?
  remoteId    String?
  partition   String?
  status      CreatorStatus @default(DRAFT)
  notes       String?
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  agency Agency @relation(fields: [agencyId], references: [id], onDelete: Cascade)

  @@index([agencyId])
  @@index([status])
}

model AuthToken {
  id        String        @id @default(cuid())
  userId    String
  type      AuthTokenType
  tokenHash String        @unique
  codeHash  String?
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime      @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([type])
  @@index([expiresAt])
}

model RefreshSession {
  id         String    @id @default(cuid())
  userId     String
  agencyId   String
  tokenHash  String    @unique
  userAgent  String?
  ipAddress  String?
  expiresAt  DateTime
  revokedAt  DateTime?
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([agencyId])
  @@index([expiresAt])
}

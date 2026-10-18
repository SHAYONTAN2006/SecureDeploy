-- CreateTable
CREATE TABLE "github_installations" (
    "id" UUID NOT NULL,
    "installationId" BIGINT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountId" BIGINT NOT NULL,
    "accountType" TEXT NOT NULL DEFAULT 'User',
    "targetType" TEXT,
    "repositorySelection" TEXT DEFAULT 'all',
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_repositories" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "repoId" BIGINT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "github_installations_userId_idx" ON "github_installations"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "github_installations_installationId_userId_key" ON "github_installations"("installationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_repositories_projectId_key" ON "project_repositories"("projectId");

-- CreateIndex
CREATE INDEX "project_repositories_installationId_idx" ON "project_repositories"("installationId");

-- CreateIndex
CREATE INDEX "project_repositories_repoId_idx" ON "project_repositories"("repoId");

-- AddForeignKey
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "github_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

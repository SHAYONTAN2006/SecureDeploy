-- CreateTable
CREATE TABLE "pipeline_runs" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryId" UUID,
    "triggeredById" UUID NOT NULL,
    "workflowFile" TEXT NOT NULL,
    "gitRef" TEXT NOT NULL,
    "commitSha" TEXT,
    "githubRunId" BIGINT,
    "githubRunNumber" INTEGER,
    "githubRunAttempt" INTEGER DEFAULT 1,
    "htmlUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_DISPATCH',
    "conclusion" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "statusCode" INTEGER NOT NULL DEFAULT 200,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_runs_githubRunId_key" ON "pipeline_runs"("githubRunId");

-- CreateIndex
CREATE INDEX "pipeline_runs_projectId_createdAt_idx" ON "pipeline_runs"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "pipeline_runs_triggeredById_idx" ON "pipeline_runs"("triggeredById");

-- CreateIndex
CREATE INDEX "pipeline_runs_githubRunId_idx" ON "pipeline_runs"("githubRunId");

-- CreateIndex
CREATE INDEX "pipeline_runs_status_idx" ON "pipeline_runs"("status");

-- AddForeignKey
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_projectRepositoryId_fkey" FOREIGN KEY ("projectRepositoryId") REFERENCES "project_repositories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

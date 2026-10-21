-- CreateTable
CREATE TABLE "security_scans" (
    "id" UUID NOT NULL,
    "pipelineRunId" UUID NOT NULL,
    "scannerName" VARCHAR(50) NOT NULL DEFAULT 'gitleaks',
    "scannerVersion" VARCHAR(50),
    "status" VARCHAR(50) NOT NULL,
    "hasFindings" BOOLEAN NOT NULL DEFAULT false,
    "findingCount" INTEGER NOT NULL DEFAULT 0,
    "reportReference" VARCHAR(255),
    "errorMessage" TEXT,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_findings" (
    "id" UUID NOT NULL,
    "scanId" UUID NOT NULL,
    "ruleId" VARCHAR(100) NOT NULL,
    "ruleDescription" VARCHAR(255),
    "filePath" VARCHAR(500) NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "startColumn" INTEGER,
    "endColumn" INTEGER,
    "commitSha" VARCHAR(40),
    "commitAuthor" VARCHAR(255),
    "commitDate" TIMESTAMP(3),
    "severity" VARCHAR(50) NOT NULL DEFAULT 'HIGH',
    "fingerprint" VARCHAR(64) NOT NULL,
    "sanitizedMatch" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_scans_pipelineRunId_idx" ON "security_scans"("pipelineRunId");

-- CreateIndex
CREATE INDEX "security_scans_scannerName_status_idx" ON "security_scans"("scannerName", "status");

-- CreateIndex
CREATE INDEX "security_findings_scanId_idx" ON "security_findings"("scanId");

-- CreateIndex
CREATE INDEX "security_findings_fingerprint_idx" ON "security_findings"("fingerprint");

-- CreateIndex
CREATE INDEX "security_findings_ruleId_idx" ON "security_findings"("ruleId");

-- AddForeignKey
ALTER TABLE "security_scans" ADD CONSTRAINT "security_scans_pipelineRunId_fkey" FOREIGN KEY ("pipelineRunId") REFERENCES "pipeline_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "security_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

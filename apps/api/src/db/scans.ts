import { prisma } from '../lib/prisma.js';
import type { NormalizedScanResult } from '../services/gitleaks.service.js';

/**
 * Persists a normalized security scan result and its sanitized findings in a transaction.
 */
export async function recordSecurityScan(pipelineRunId: string, scanResult: NormalizedScanResult) {
  return prisma.$transaction(async (tx) => {
    const scan = await tx.securityScan.create({
      data: {
        pipelineRunId,
        scannerName: scanResult.scannerName,
        scannerVersion: scanResult.scannerVersion || null,
        status: scanResult.status,
        hasFindings: scanResult.hasFindings,
        findingCount: scanResult.findingCount,
        reportReference: scanResult.reportReference || null,
        errorMessage: scanResult.errorMessage || null,
        findings: {
          create: scanResult.findings.map((f) => ({
            ruleId: f.ruleId,
            ruleDescription: f.ruleDescription || null,
            filePath: f.filePath,
            startLine: f.startLine || null,
            endLine: f.endLine || null,
            startColumn: f.startColumn || null,
            endColumn: f.endColumn || null,
            commitSha: f.commitSha || null,
            commitAuthor: f.commitAuthor || null,
            commitDate: f.commitDate || null,
            severity: f.severity,
            fingerprint: f.fingerprint,
            sanitizedMatch: f.sanitizedMatch || null,
          })),
        },
      },
      include: {
        findings: true,
      },
    });

    return scan;
  });
}

/**
 * Retrieves all security scans and their findings for a specific pipeline run.
 */
export async function findSecurityScansByPipelineRunId(pipelineRunId: string) {
  return prisma.securityScan.findMany({
    where: { pipelineRunId },
    include: {
      findings: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Retrieves a single security scan by ID.
 */
export async function findSecurityScanById(scanId: string) {
  return prisma.securityScan.findUnique({
    where: { id: scanId },
    include: {
      findings: true,
    },
  });
}

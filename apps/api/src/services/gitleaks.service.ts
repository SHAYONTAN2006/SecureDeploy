import crypto from 'node:crypto';
import zlib from 'node:zlib';

export interface RawGitleaksFinding {
  Description?: string;
  StartLine?: number;
  EndLine?: number;
  StartColumn?: number;
  EndColumn?: number;
  Match?: string;
  Secret?: string;
  File?: string;
  SymlinkFile?: string;
  Commit?: string;
  Entropy?: number;
  Author?: string;
  Email?: string;
  Date?: string;
  Message?: string;
  Tags?: string[];
  RuleID?: string;
  Fingerprint?: string;
}

export interface NormalizedSecurityFinding {
  ruleId: string;
  ruleDescription?: string | null;
  filePath: string;
  startLine?: number | null;
  endLine?: number | null;
  startColumn?: number | null;
  endColumn?: number | null;
  commitSha?: string | null;
  commitAuthor?: string | null;
  commitDate?: Date | null;
  severity: string;
  fingerprint: string;
  sanitizedMatch?: string | null;
}

export interface NormalizedScanResult {
  scannerName: string;
  scannerVersion?: string | null;
  status: 'SUCCESS' | 'ERROR';
  hasFindings: boolean;
  findingCount: number;
  reportReference?: string | null;
  errorMessage?: string | null;
  findings: NormalizedSecurityFinding[];
}

/**
 * Sanitizes the code match snippet by strictly redacting any secret value.
 * Never allows the plaintext secret to leak into sanitized output or logs.
 */
export function sanitizeSecretMatch(match?: string, secret?: string): string | null {
  if (!match) return null;
  if (!secret || secret.trim() === '') {
    // If secret substring is not explicitly passed, redact standard credential assignments
    return match.replace(/(=|:)\s*(["']?)[^\s"'\r\n]+(["']?)/g, '$1 $2[REDACTED]$3');
  }
  // Escape regex special characters in secret before string substitution
  const escapedSecret = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return match.replace(new RegExp(escapedSecret, 'g'), '[REDACTED]');
}

/**
 * Generates a stable, collision-resistant SHA-256 fingerprint for deduplicating findings.
 */
export function generateFindingFingerprint(finding: {
  ruleId: string;
  filePath: string;
  commitSha?: string | null;
  startLine?: number | null;
  rawFingerprint?: string | null;
}): string {
  if (finding.rawFingerprint && finding.rawFingerprint.trim()) {
    return crypto.createHash('sha256').update(finding.rawFingerprint.trim()).digest('hex');
  }
  const content = `${finding.ruleId}:${finding.filePath}:${finding.commitSha || ''}:${finding.startLine || 0}`;
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Maps Gitleaks detection rules to standard severity levels.
 */
export function getSecretSeverity(ruleId: string): string {
  const normalized = ruleId.toLowerCase();
  if (
    normalized.includes('private-key') ||
    normalized.includes('aws') ||
    normalized.includes('github') ||
    normalized.includes('token') ||
    normalized.includes('secret-key') ||
    normalized.includes('jwt') ||
    normalized.includes('password')
  ) {
    return 'CRITICAL';
  }
  return 'HIGH';
}

/**
 * Parses and normalizes a Gitleaks JSON report into SecureDeploy's standard security schema.
 * Automatically redacts all secrets and computes deduplication fingerprints.
 */
export function parseAndNormalizeGitleaksReport(
  rawInput: string | unknown[],
  options?: { reportReference?: string; scannerVersion?: string }
): NormalizedScanResult {
  let parsed: unknown[];

  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (!trimmed || trimmed === '[]') {
      return {
        scannerName: 'gitleaks',
        scannerVersion: options?.scannerVersion || '8.21.2',
        status: 'SUCCESS',
        hasFindings: false,
        findingCount: 0,
        reportReference: options?.reportReference || null,
        errorMessage: null,
        findings: [],
      };
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        scannerName: 'gitleaks',
        scannerVersion: options?.scannerVersion || '8.21.2',
        status: 'ERROR',
        hasFindings: false,
        findingCount: 0,
        reportReference: options?.reportReference || null,
        errorMessage: `Failed to parse Gitleaks report JSON: ${message}`,
        findings: [],
      };
    }
  } else if (Array.isArray(rawInput)) {
    parsed = rawInput;
  } else {
    return {
      scannerName: 'gitleaks',
      scannerVersion: options?.scannerVersion || '8.21.2',
      status: 'ERROR',
      hasFindings: false,
      findingCount: 0,
      reportReference: options?.reportReference || null,
      errorMessage: 'Invalid Gitleaks report format: Expected JSON array',
      findings: [],
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      scannerName: 'gitleaks',
      scannerVersion: options?.scannerVersion || '8.21.2',
      status: 'ERROR',
      hasFindings: false,
      findingCount: 0,
      reportReference: options?.reportReference || null,
      errorMessage: 'Invalid Gitleaks report format: Root element is not an array',
      findings: [],
    };
  }

  const findings: NormalizedSecurityFinding[] = parsed.map((rawItem: unknown) => {
    const item = (rawItem && typeof rawItem === 'object' ? rawItem : {}) as Record<string, unknown>;
    const ruleId = String(item.RuleID || item.ruleId || 'generic-secret');
    const filePath = String(item.File || item.filePath || 'unknown');
    const startLine = typeof item.StartLine === 'number' ? item.StartLine : null;
    const endLine = typeof item.EndLine === 'number' ? item.EndLine : null;
    const startColumn = typeof item.StartColumn === 'number' ? item.StartColumn : null;
    const endColumn = typeof item.EndColumn === 'number' ? item.EndColumn : null;
    const commitSha = typeof item.Commit === 'string' ? item.Commit : null;
    const commitAuthor = typeof item.Author === 'string' ? item.Author : null;
    const commitDate =
      typeof item.Date === 'string' || item.Date instanceof Date
        ? new Date(item.Date as string)
        : null;
    const rawSecret = typeof item.Secret === 'string' ? item.Secret : undefined;
    const rawMatch = typeof item.Match === 'string' ? item.Match : undefined;

    const sanitizedMatch = sanitizeSecretMatch(rawMatch, rawSecret);
    const fingerprint = generateFindingFingerprint({
      ruleId,
      filePath,
      commitSha,
      startLine,
      rawFingerprint: typeof item.Fingerprint === 'string' ? item.Fingerprint : null,
    });

    return {
      ruleId,
      ruleDescription:
        typeof item.Description === 'string'
          ? item.Description
          : `Potential secret matching rule ${ruleId}`,
      filePath,
      startLine,
      endLine,
      startColumn,
      endColumn,
      commitSha,
      commitAuthor,
      commitDate,
      severity: getSecretSeverity(ruleId),
      fingerprint,
      sanitizedMatch,
    };
  });

  return {
    scannerName: 'gitleaks',
    scannerVersion: options?.scannerVersion || '8.21.2',
    status: 'SUCCESS',
    hasFindings: findings.length > 0,
    findingCount: findings.length,
    reportReference: options?.reportReference || null,
    errorMessage: null,
    findings,
  };
}

/**
 * Extracts a specific named file from a standard PKZip archive buffer.
 * Supports Stored (method 0) and Deflated (method 8) compression methods.
 */
export function extractFileFromZip(zipBuffer: Buffer, targetFileName: string): string | null {
  let offset = 0;
  while (offset + 30 <= zipBuffer.length) {
    // Check local file header signature: 0x04034b50
    if (zipBuffer.readUInt32LE(offset) !== 0x04034b50) {
      break;
    }

    const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 28);

    const fileNameStart = offset + 30;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > zipBuffer.length) break;

    const fileName = zipBuffer.toString('utf8', fileNameStart, fileNameEnd);
    const dataStart = fileNameEnd + extraFieldLength;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > zipBuffer.length) break;

    if (fileName === targetFileName || fileName.endsWith('/' + targetFileName)) {
      const compressedData = zipBuffer.subarray(dataStart, dataEnd);
      if (compressionMethod === 0) {
        return compressedData.toString('utf8');
      } else if (compressionMethod === 8) {
        return zlib.inflateRawSync(compressedData).toString('utf8');
      }
    }

    offset = dataEnd;
  }
  return null;
}

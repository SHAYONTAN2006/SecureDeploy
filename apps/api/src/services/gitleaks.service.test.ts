import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import {
  sanitizeSecretMatch,
  generateFindingFingerprint,
  getSecretSeverity,
  parseAndNormalizeGitleaksReport,
  extractFileFromZip,
  type RawGitleaksFinding,
} from './gitleaks.service.js';

describe('Gitleaks Scanner Service Unit Tests', () => {
  describe('Secret Sanitization and Redaction', () => {
    it('completely redacts plaintext secret from match string', () => {
      const match = 'export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
      const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

      const sanitized = sanitizeSecretMatch(match, secret);
      expect(sanitized).toBe('export AWS_SECRET_ACCESS_KEY="[REDACTED]"');
      expect(sanitized).not.toContain(secret);
    });

    it('redacts multiple occurrences of the secret if present in match', () => {
      const match = 'token: secret123, backup: secret123';
      const secret = 'secret123';

      const sanitized = sanitizeSecretMatch(match, secret);
      expect(sanitized).toBe('token: [REDACTED], backup: [REDACTED]');
      expect(sanitized).not.toContain(secret);
    });

    it('safely handles special regex characters in secret without throwing', () => {
      const match = 'password: [abc]+.*(?=123)';
      const secret = '[abc]+.*(?=123)';

      const sanitized = sanitizeSecretMatch(match, secret);
      expect(sanitized).toBe('password: [REDACTED]');
      expect(sanitized).not.toContain(secret);
    });

    it('redacts standard credential assignments when secret substring is omitted', () => {
      const match = 'GITHUB_TOKEN=ghp_ABC1234567890XYZ';
      const sanitized = sanitizeSecretMatch(match, undefined);

      expect(sanitized).toBe('GITHUB_TOKEN= [REDACTED]');
      expect(sanitized).not.toContain('ghp_ABC1234567890XYZ');
    });

    it('returns null when match string is empty or undefined', () => {
      expect(sanitizeSecretMatch(undefined, 'secret')).toBeNull();
      expect(sanitizeSecretMatch('', 'secret')).toBeNull();
    });
  });

  describe('Deduplication Fingerprint Generation', () => {
    it('generates a deterministic 64-character hex SHA-256 fingerprint', () => {
      const fp1 = generateFindingFingerprint({
        ruleId: 'aws-access-token',
        filePath: 'config/aws.ts',
        commitSha: 'a1b2c3d4e5f67890123456789012345678901234',
        startLine: 15,
      });

      const fp2 = generateFindingFingerprint({
        ruleId: 'aws-access-token',
        filePath: 'config/aws.ts',
        commitSha: 'a1b2c3d4e5f67890123456789012345678901234',
        startLine: 15,
      });

      expect(fp1).toHaveLength(64);
      expect(fp1).toBe(fp2);
    });

    it('produces distinct fingerprints for different locations or rules', () => {
      const fp1 = generateFindingFingerprint({
        ruleId: 'aws-access-token',
        filePath: 'config/aws.ts',
        startLine: 15,
      });

      const fp2 = generateFindingFingerprint({
        ruleId: 'aws-access-token',
        filePath: 'config/aws.ts',
        startLine: 20,
      });

      const fp3 = generateFindingFingerprint({
        ruleId: 'github-pat',
        filePath: 'config/aws.ts',
        startLine: 15,
      });

      expect(fp1).not.toBe(fp2);
      expect(fp1).not.toBe(fp3);
    });

    it('hashes upstream Gitleaks fingerprint if provided', () => {
      const upstream = 'commit-sha:file.ts:rule:12';
      const fp = generateFindingFingerprint({
        ruleId: 'rule',
        filePath: 'file.ts',
        rawFingerprint: upstream,
      });
      expect(fp).toHaveLength(64);
    });
  });

  describe('Severity Classification', () => {
    it('maps high-risk tokens and private keys to CRITICAL severity', () => {
      expect(getSecretSeverity('aws-access-token')).toBe('CRITICAL');
      expect(getSecretSeverity('github-pat')).toBe('CRITICAL');
      expect(getSecretSeverity('private-key')).toBe('CRITICAL');
      expect(getSecretSeverity('jwt-secret-key')).toBe('CRITICAL');
      expect(getSecretSeverity('database-password')).toBe('CRITICAL');
    });

    it('defaults generic secrets to HIGH severity', () => {
      expect(getSecretSeverity('generic-api-key')).toBe('HIGH');
      expect(getSecretSeverity('webhook-url')).toBe('HIGH');
    });
  });

  describe('Report Parsing and Normalization', () => {
    it('normalizes a clean scan with 0 findings', () => {
      const result = parseAndNormalizeGitleaksReport('[]');

      expect(result.status).toBe('SUCCESS');
      expect(result.hasFindings).toBe(false);
      expect(result.findingCount).toBe(0);
      expect(result.findings).toHaveLength(0);
      expect(result.errorMessage).toBeNull();
    });

    it('normalizes a report with secret findings and strips all plaintext secrets', () => {
      const mockRawFindings: RawGitleaksFinding[] = [
        {
          Description: 'GitHub Personal Access Token',
          StartLine: 10,
          EndLine: 10,
          StartColumn: 1,
          EndColumn: 45,
          Match: 'GH_TOKEN="ghp_1234567890abcdefghijklmnopqrstuvwxyz"',
          Secret: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
          File: 'src/services/github.ts',
          Commit: 'f1e2d3c4b5a67890123456789012345678901234',
          Author: 'Test Developer <dev@example.com>',
          Date: '2026-10-20T12:00:00Z',
          RuleID: 'github-pat',
          Fingerprint: 'mock-upstream-fp-1',
        },
        {
          Description: 'Generic API Key',
          StartLine: 42,
          EndLine: 42,
          Match: 'api_key: "sec_abc123456789"',
          Secret: 'sec_abc123456789',
          File: 'src/config.ts',
          RuleID: 'generic-api-key',
        },
      ];

      const result = parseAndNormalizeGitleaksReport(mockRawFindings, {
        reportReference: 'artifact:gitleaks-report',
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.hasFindings).toBe(true);
      expect(result.findingCount).toBe(2);
      expect(result.reportReference).toBe('artifact:gitleaks-report');

      // Verify finding 1
      const f1 = result.findings[0];
      expect(f1.ruleId).toBe('github-pat');
      expect(f1.ruleDescription).toBe('GitHub Personal Access Token');
      expect(f1.filePath).toBe('src/services/github.ts');
      expect(f1.startLine).toBe(10);
      expect(f1.severity).toBe('CRITICAL');
      expect(f1.sanitizedMatch).toBe('GH_TOKEN="[REDACTED]"');
      expect(f1.sanitizedMatch).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
      expect('Secret' in f1).toBe(false); // NEVER has Secret property

      // Verify finding 2
      const f2 = result.findings[1];
      expect(f2.ruleId).toBe('generic-api-key');
      expect(f2.filePath).toBe('src/config.ts');
      expect(f2.severity).toBe('HIGH');
      expect(f2.sanitizedMatch).toBe('api_key: "[REDACTED]"');
      expect(f2.sanitizedMatch).not.toContain('sec_abc123456789');
      expect('Secret' in f2).toBe(false);
    });

    it('safely handles malformed non-JSON inputs and records scanner error', () => {
      const result = parseAndNormalizeGitleaksReport('INVALID NON-JSON OUTPUT FROM CRASH');

      expect(result.status).toBe('ERROR');
      expect(result.hasFindings).toBe(false);
      expect(result.findingCount).toBe(0);
      expect(result.errorMessage).toContain('Failed to parse Gitleaks report JSON');
    });

    it('handles non-array JSON inputs gracefully', () => {
      const result = parseAndNormalizeGitleaksReport('{"error": "invalid config"}');

      expect(result.status).toBe('ERROR');
      expect(result.hasFindings).toBe(false);
      expect(result.errorMessage).toContain('Root element is not an array');
    });
  });

  describe('Zip File Extraction', () => {
    it('extracts uncompressed (stored) file from zip archive buffer', () => {
      const content = JSON.stringify([{ RuleID: 'test', File: 'test.ts' }]);
      const filename = 'gitleaks-report.json';
      const fnBuf = Buffer.from(filename, 'utf8');
      const dataBuf = Buffer.from(content, 'utf8');

      // Construct a minimal valid PKZip local header
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0); // signature
      header.writeUInt16LE(20, 4); // version needed
      header.writeUInt16LE(0, 6); // flags
      header.writeUInt16LE(0, 8); // compression method: 0 (Stored)
      header.writeUInt32LE(0, 10); // mod time/date
      header.writeUInt32LE(0, 14); // crc32
      header.writeUInt32LE(dataBuf.length, 18); // compressed size
      header.writeUInt32LE(dataBuf.length, 22); // uncompressed size
      header.writeUInt16LE(fnBuf.length, 26); // file name length
      header.writeUInt16LE(0, 28); // extra field length

      const zipBuf = Buffer.concat([header, fnBuf, dataBuf]);
      const extracted = extractFileFromZip(zipBuf, 'gitleaks-report.json');

      expect(extracted).toBe(content);
    });

    it('extracts deflated (method 8) file from zip archive buffer', () => {
      const content = JSON.stringify([{ RuleID: 'test-deflated', File: 'app.ts' }]);
      const filename = 'gitleaks-report.json';
      const fnBuf = Buffer.from(filename, 'utf8');
      const rawData = Buffer.from(content, 'utf8');
      const deflatedData = zlib.deflateRawSync(rawData);

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0); // signature
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0, 6);
      header.writeUInt16LE(8, 8); // compression method: 8 (Deflated)
      header.writeUInt32LE(0, 10);
      header.writeUInt32LE(0, 14);
      header.writeUInt32LE(deflatedData.length, 18); // compressed size
      header.writeUInt32LE(rawData.length, 22); // uncompressed size
      header.writeUInt16LE(fnBuf.length, 26);
      header.writeUInt16LE(0, 28);

      const zipBuf = Buffer.concat([header, fnBuf, deflatedData]);
      const extracted = extractFileFromZip(zipBuf, 'gitleaks-report.json');

      expect(extracted).toBe(content);
    });

    it('returns null if target file is not found in zip archive', () => {
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(0, 8);
      header.writeUInt32LE(0, 18);
      header.writeUInt32LE(0, 22);
      header.writeUInt16LE(8, 26);
      header.writeUInt16LE(0, 28);

      const zipBuf = Buffer.concat([header, Buffer.from('other.txt', 'utf8')]);
      expect(extractFileFromZip(zipBuf, 'gitleaks-report.json')).toBeNull();
    });
  });
});

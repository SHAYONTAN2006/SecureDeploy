# SecureDeploy — Initial Threat Model

## 1. Introduction & Objectives

This threat model outlines the initial security assumptions, trust boundaries, asset inventory, primary threat scenarios, and planned mitigations for the **SecureDeploy** platform. It adopts the STRIDE methodology (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege) to inform architectural decisions from the earliest foundation phase.

---

## 2. Core Security Assumptions

1. **Host Environment Integrity**: The underlying host operating system and GitHub infrastructure are maintained and patched by trusted providers.
2. **Secrets Segregation**: Production secrets are never stored in source control, client bundles, or standard image layers; they are stored exclusively in dedicated secret stores (AWS Secrets Manager) and injected securely at runtime.
3. **Defense in Depth**: No single layer (e.g., perimeter firewall or client-side check) is assumed to provide complete protection. All API routes, scanner inputs, and policy evaluations must validate inputs independently.
4. **Zero-Trust Network Model**: Internal communications between network tiers (e.g., ALB to ECS, ECS to RDS) are scoped via strict Security Groups and encrypted in transit via TLS.

---

## 3. Trust Boundaries

```
[ Browser / Public Internet ]
           |
       (Boundary 1: Public Ingress / CloudFront & ALB)
           v
[ Application Layer: apps/web & apps/api (ECS Fargate) ]
           |
       (Boundary 2: Service-to-Storage Isolation / VPC Private Subnets)
           v
[ Persistence & Cloud Services: RDS PostgreSQL, Secrets Manager, KMS, S3 ]
           ^
       (Boundary 3: Automation Ingress / OIDC Provider)
           |
[ CI/CD Runners: GitHub Actions with Temporary AWS IAM Credentials ]
```

- **Trust Boundary 1 (Public vs. Private)**: Traffic entering the platform from public browsers or external webhooks crossing CloudFront and ALB into private subnets.
- **Trust Boundary 2 (Application vs. Persistence)**: Application containers in private subnets communicating with database storage, encryption keys, and secret stores.
- **Trust Boundary 3 (CI/CD Pipeline vs. Cloud Infrastructure)**: Pipeline workers executing code scans, packaging artifacts, and requesting short-lived deployment permissions via AWS IAM OIDC.

---

## 4. Primary Assets

- **Source Code Repositories**: Proprietary application logic, infrastructure code, and configuration scripts.
- **Scanner Finding Reports**: Sensitive vulnerability and vulnerability location data that could be leveraged by attackers if leaked.
- **Cloud Infrastructure & Credentials**: AWS IAM roles, API tokens, database master credentials, and container registries.
- **Deployment Artifacts**: Production container images stored in Amazon ECR.
- **Audit Logs**: Immutable records of policy evaluations, overrides, and deployment events.

---

## 5. Threat Scenarios & Mitigations (STRIDE Matrix)

| STRIDE Category            | Threat Description                                                                                                     | Potential Impact                                                       | Planned Mitigation                                                                                                                                                                    |
| :------------------------- | :--------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Spoofing**               | Adversary impersonates a developer or CI runner to trigger unauthorized production deployment                          | Unauthorized code execution in production                              | GitHub Actions OIDC federation with short-lived AWS IAM role assumption; no long-lived static AWS keys; branch protection rules.                                                      |
| **Tampering**              | Malicious alteration of scanner outputs or policy evaluation rules to bypass security gates                            | Vulnerable or backdoored artifacts deployed to production              | Policy evaluation executed within controlled server-side environment; scanner outputs cryptographically checksummed and validated against schema.                                     |
| **Repudiation**            | User denies performing an emergency policy override or manual deployment                                               | Lack of accountability during incident triage                          | Centralized audit logging to append-only CloudWatch log groups with integrity verification.                                                                                           |
| **Information Disclosure** | Credentials, API tokens, or internal vulnerability reports leaked through API responses, error logs, or client bundles | Compromise of downstream services; targeted exploitation of known CVEs | Static code secret scanning with Gitleaks; environment variable isolation; structured error handling omitting internal stack traces; AWS Secrets Manager with KMS encryption at rest. |
| **Denial of Service**      | Malicious volumetric traffic floods API endpoints or large payloads exhaust Node.js event loop                         | Service degradation or unresponsiveness                                | AWS ALB rate limiting; Express body-size limits; helmet security headers; ECS auto-scaling.                                                                                           |
| **Elevation of Privilege** | Container escape or IAM misconfiguration allows unauthorized cross-service access                                      | Full cloud account takeover                                            | Read-only container root filesystems; non-root Docker user; minimal IAM task execution roles scoped strictly per service.                                                             |

---

## 6. Implementation Timeline & Roadmap

- **Phase 0 (Foundation)**: Establish trust boundary documentation, sanitize initial configuration, and prohibit secret inclusion in repository files.
- **Phase 2 (Scanners)**: Implement Gitleaks, Semgrep, Trivy, and Checkov to automate vulnerability and credential exposure detection.
- **Phase 3 (Policy Engine)**: Codify unbypassable gating logic preventing high-severity issues from progressing.
- **Phase 5 (Infrastructure)**: Deploy Terraform modules incorporating AWS security best practices (VPC private subnets, security group segregation, KMS customer managed keys).

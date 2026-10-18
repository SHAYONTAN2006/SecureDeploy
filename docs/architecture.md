# SecureDeploy — System Architecture

## 1. Architectural Overview

SecureDeploy is architected as a modular, cloud-ready deployment platform composed of a modern web interface, a modular backend API, security analysis pipelines, a policy evaluation engine, and declarative cloud infrastructure managed via Terraform on AWS.

```
+-----------------------------------------------------------------------------------+
|                                  SecureDeploy                                     |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  +--------------------+        HTTPS        +----------------------------------+  |
|  |     apps/web       | ------------------> |            apps/api              |  |
|  |  (React/Vite/TS)   | <------------------ |     (Express/Modular Monolith)   |  |
|  +--------------------+                     +----------------------------------+  |
|                                                              |                    |
|                                                              | (Future Phase)     |
|                                                              v                    |
|                                             +----------------------------------+  |
|                                             |       PostgreSQL / Prisma        |  |
|                                             +----------------------------------+  |
|                                                                                   |
+-----------------------------------------------------------------------------------+
                                       |
                   +-------------------+-------------------+
                   |                                       |
                   v                                       v
+-------------------------------------+ +------------------------------------------+
|          CI/CD & Scanners           | |            AWS Infrastructure            |
|          (GitHub Actions)           | |               (Terraform)                |
+-------------------------------------+ +------------------------------------------+
|  * Gitleaks (Secrets)               | |  * CloudFront + S3 (Static Web Hosting)  |
|  * Semgrep (SAST)                   | |  * ALB + ECS Fargate (Containerized API) |
|  * Trivy (SCA & Containers)         | |  * Amazon RDS (PostgreSQL Database)      |
|  * Checkov (IaC)                    | |  * Secrets Manager & KMS (Secrets)       |
|  * Policy Engine (Evaluation)       | |  * IAM & CloudWatch (Auth & Telemetry)   |
+-------------------------------------+ +------------------------------------------+
```

---

## 2. Component Responsibilities

### A. Frontend (`apps/web`)

- **Technology**: React, Vite, TypeScript, Tailwind CSS.
- **Current Status (Phase 0)**: Minimal placeholder landing interface confirming system vitality and basic UI layout foundation.
- **Planned Role**:
  - Display dashboard metrics: scan findings, security compliance status, deployment logs.
  - Allow policy configuration and override management for authorized administrators.
  - Provide real-time build and deployment status visualization.

### B. Backend (`apps/api`)

- **Technology**: Node.js, Express, TypeScript (Modular Monolith pattern).
- **Current Status (Phase 0)**: Minimal HTTP API with standard middleware, structured error handling, and `GET /api/health` endpoint.
- **Planned Role**:
  - Ingest scan results from CI/CD pipeline workers.
  - Execute policy validation rules against normalized scan outputs.
  - Manage deployment lifecycle states (QUEUED, ANALYZING, APPROVED, DEPLOYING, FAILED, COMPLETED).
  - Expose REST endpoints for project management, scan telemetry, and audit logs.

### C. Security Scanners (Planned)

- **Gitleaks**: Scans git repositories and commit histories to prevent secret and token leakage before code reaches target branches.
- **Semgrep**: Lightweight Static Application Security Testing (SAST) analyzing source code for injection risks, logic flaws, and insecure patterns.
- **Trivy**: Comprehensive vulnerability scanner detecting CVEs in base container images and third-party dependency manifests (npm packages).
- **Checkov**: Static code analysis for Infrastructure as Code (IaC), scanning Terraform configurations for AWS compliance and least-privilege adherence.

### D. Policy Engine (Planned)

- **Technology**: TypeScript domain module running within the backend / CI worker.
- **Responsibility**:
  - Accepts unified vulnerability reports from all scanners.
  - Evaluates configurable rules (e.g., `FAIL if severity >= HIGH`, `FAIL if any plain text secret detected`, `FAIL if unencrypted S3 bucket`).
  - Emits deterministic pass/fail decisions along with detailed remediation guidance.

### E. CI/CD Workflows (Planned)

- **Technology**: GitHub Actions.
- **Responsibility**:
  - Orchestrates automated linting, unit testing, security scanning, container image builds (Docker), and pushing to Amazon ECR.
  - Invokes the Policy Engine to gate branch merges and deployments.

### F. Cloud Infrastructure & Terraform (Planned)

- **Technology**: HashiCorp Terraform targeting Amazon Web Services (AWS).
- **Target Services**:
  - **AWS ECS (Fargate)**: Serverless container compute running the `apps/api` application container.
  - **AWS Application Load Balancer (ALB)**: SSL/TLS termination, health checking, and routing traffic to ECS tasks.
  - **AWS S3 & CloudFront**: Secure object storage and low-latency global CDN distribution for the `apps/web` single-page application.
  - **Amazon RDS (PostgreSQL)**: Multi-AZ relational database for persistent storage.
  - **AWS Secrets Manager & KMS**: Hardware-backed secret storage and encryption key management.
  - **AWS IAM**: Role-based access control enforcing least privilege across ECS task roles and CI/CD deployers.
  - **Amazon CloudWatch**: Centralized log streaming and metrics alarms.

---

## 3. Implementation Status Summary

| Component                                |       Implemented in Phase 0       |    Planned in Later Phases     |
| :--------------------------------------- | :--------------------------------: | :----------------------------: |
| **npm Monorepo Workspaces**              |                Yes                 |      Ongoing enhancement       |
| **apps/web (React/Vite/TS/Tailwind)**    |         Minimal Foundation         | Full Dashboard & Governance UI |
| **apps/api (Node/Express/TS)**           | Minimal Foundation (`/api/health`) | Full Domain Logic & API routes |
| **PostgreSQL & Prisma**                  |                 No                 |            Phase 1             |
| **Gitleaks / Semgrep / Trivy / Checkov** |                 No                 |            Phase 2             |
| **Policy Engine**                        |                 No                 |            Phase 3             |
| **GitHub Actions Workflows**             |                 No                 |            Phase 4             |
| **AWS ECS, ALB, RDS, S3, CloudFront**    |                 No                 |            Phase 5             |
| **Terraform IaC Modules**                |                 No                 |            Phase 5             |

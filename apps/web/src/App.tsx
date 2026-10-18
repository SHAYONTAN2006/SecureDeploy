import { useState, useEffect } from 'react';

interface ApiHealthResponse {
  status: string;
  service: string;
  timestamp: string;
  uptime: number;
}

interface GithubStatusResponse {
  configured: boolean;
  slug?: string;
  message?: string;
}

export default function App() {
  const [apiHealth, setApiHealth] = useState<ApiHealthResponse | null>(null);
  const [githubStatus, setGithubStatus] = useState<GithubStatusResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';

  useEffect(() => {
    Promise.all([
      fetch(`${apiUrl}/api/health`)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
      fetch(`${apiUrl}/api/github/status`)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    ])
      .then(([healthData, ghData]) => {
        if (healthData) {
          setApiHealth(healthData);
        } else {
          setError('Backend API is unreachable');
        }
        if (ghData) {
          setGithubStatus(ghData);
        }
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [apiUrl]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-emerald-500 selection:text-slate-950">
      {/* Navigation Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-10 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="h-8 w-8 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold">
              SD
            </div>
            <div>
              <span className="font-bold tracking-tight text-lg">SecureDeploy</span>
              <span className="ml-2 text-xs font-mono uppercase bg-slate-800 text-slate-400 px-2 py-0.5 rounded">
                Phase 2
              </span>
            </div>
          </div>
          <div className="flex items-center space-x-3 text-xs">
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-950/80 text-emerald-300 border border-emerald-800">
              <span className="w-1.5 h-1.5 mr-1.5 bg-emerald-400 rounded-full animate-pulse"></span>
              Core System Active
            </span>
          </div>
        </div>
      </header>

      {/* Main Body */}
      <main className="max-w-6xl mx-auto px-6 py-12 flex-grow w-full">
        {/* Hero Section */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-4 bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
            Automated Security Governance &amp; Cloud Deployment
          </h1>
          <p className="text-slate-400 text-base sm:text-lg">
            Bridging CI/CD pipelines with vulnerability scanning, secret detection, policy
            enforcement, and automated AWS ECS provisioning.
          </p>
        </div>

        {/* Status Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          {/* System Vitality Card */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
                Backend API Vitality
              </h2>
              <span className="text-xs font-mono text-slate-500">GET /api/health</span>
            </div>

            {loading ? (
              <div className="text-slate-400 text-sm animate-pulse">Checking API status...</div>
            ) : error ? (
              <div className="bg-amber-950/40 border border-amber-900/60 rounded-lg p-4 text-xs text-amber-200">
                <div className="font-semibold mb-1">API Disconnected or Offline</div>
                <div className="text-amber-300/80">
                  Make sure `apps/api` is running on port 5000 ({error}).
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between bg-slate-950/80 p-3 rounded-lg border border-slate-800">
                  <span className="text-xs text-slate-400">Service</span>
                  <span className="text-xs font-mono font-medium text-emerald-400">
                    {apiHealth?.service}
                  </span>
                </div>
                <div className="flex items-center justify-between bg-slate-950/80 p-3 rounded-lg border border-slate-800">
                  <span className="text-xs text-slate-400">Health Status</span>
                  <span className="text-xs font-mono font-medium text-emerald-400 uppercase">
                    {apiHealth?.status}
                  </span>
                </div>
                <div className="flex items-center justify-between bg-slate-950/80 p-3 rounded-lg border border-slate-800">
                  <span className="text-xs text-slate-400">Uptime</span>
                  <span className="text-xs font-mono text-slate-300">{apiHealth?.uptime}s</span>
                </div>
              </div>
            )}
          </div>

          {/* GitHub App Integration Card */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
                GitHub App Integration
              </h2>
              <span className="text-xs font-mono text-slate-500">Phase 2</span>
            </div>

            {githubStatus?.configured ? (
              <div className="space-y-3">
                <div className="bg-emerald-950/30 border border-emerald-800/60 rounded-lg p-3 text-xs text-emerald-300">
                  <div className="font-semibold mb-1">GitHub App Configured</div>
                  <div className="text-emerald-400/80 font-mono">App Slug: {githubStatus.slug}</div>
                </div>
                <a
                  href={`${apiUrl}/api/github/install?redirect=true`}
                  className="block text-center py-2 px-3 bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-semibold rounded-lg text-xs transition-colors"
                >
                  Connect GitHub Account
                </a>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3 text-xs text-slate-400">
                  <div className="font-semibold text-slate-300 mb-1">Setup Required</div>
                  <p className="text-[11px] text-slate-500">
                    Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` in `.env` to enable
                    multi-user repository linking.
                  </p>
                </div>
                <span className="inline-block py-1.5 px-3 bg-slate-800 text-slate-500 text-xs rounded-lg cursor-not-allowed">
                  Awaiting App Credentials
                </span>
              </div>
            )}
          </div>

          {/* Architecture Overview Card */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-4">
              Foundation Architecture
            </h2>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="bg-slate-950/80 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 mb-1">Frontend</div>
                <div className="font-medium text-slate-200">React + Vite + Tailwind</div>
              </div>
              <div className="bg-slate-950/80 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 mb-1">Backend</div>
                <div className="font-medium text-slate-200">Express + TypeScript</div>
              </div>
              <div className="bg-slate-950/80 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 mb-1">Database</div>
                <div className="font-medium text-slate-200">PostgreSQL + Prisma</div>
              </div>
              <div className="bg-slate-950/80 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 mb-1">Auth &amp; Session</div>
                <div className="font-medium text-slate-200">Argon2id + PG Session</div>
              </div>
            </div>
          </div>
        </div>

        {/* Roadmap Preview */}
        <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-4">
            Security &amp; Automation Roadmap
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="border border-emerald-800/50 p-3 rounded-lg bg-emerald-950/20">
              <span className="block text-emerald-400 text-[10px] uppercase font-mono">
                Phase 2 Active
              </span>
              <span className="font-medium text-slate-200">GitHub App Integration</span>
            </div>
            <div className="border border-slate-800 p-3 rounded-lg bg-slate-950/40">
              <span className="block text-slate-500 text-[10px] uppercase font-mono">
                Phase 2 Planned
              </span>
              <span className="font-medium text-slate-300">Gitleaks &amp; Semgrep</span>
            </div>
            <div className="border border-slate-800 p-3 rounded-lg bg-slate-950/40">
              <span className="block text-slate-500 text-[10px] uppercase font-mono">
                Phase 2 Planned
              </span>
              <span className="font-medium text-slate-300">Trivy &amp; Checkov</span>
            </div>
            <div className="border border-slate-800 p-3 rounded-lg bg-slate-950/40">
              <span className="block text-slate-500 text-[10px] uppercase font-mono">
                Phase 3 Planned
              </span>
              <span className="font-medium text-slate-300">Policy Engine</span>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/60 py-6 text-center text-xs text-slate-500">
        SecureDeploy &bull; Phase 2 Active Development &bull; Internal Development Mode
      </footer>
    </div>
  );
}

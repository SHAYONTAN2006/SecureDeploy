import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from './App.js';

describe('SecureDeploy Web Application Smoke Test', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: 'ok',
              service: 'securedeploy-api',
              timestamp: new Date().toISOString(),
              uptime: 42,
            }),
        })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders landing page with title and branding', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText(/SecureDeploy/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText(/Automated Security Governance/i)).toBeDefined();
      expect(screen.getByText(/Foundation Architecture/i)).toBeDefined();
    });
  });
});

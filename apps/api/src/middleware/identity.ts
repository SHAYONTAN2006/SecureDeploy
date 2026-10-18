/**
 * @deprecated Development identity has been replaced by session-based authentication in Task 3.
 * Preserved for test compatibility.
 */
import { createTestAuthMiddleware, type AuthUser } from './auth.js';

export { type AuthUser };
export const createTestIdentityMiddleware = createTestAuthMiddleware;

import { z } from 'zod';

export const linkRepositorySchema = z.object({
  installationId: z.string({ required_error: 'installationId is required' }).min(1),
  repoId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)], {
    required_error: 'repoId is required',
  }),
  repoOwner: z.string().trim().min(1).max(100),
  repoName: z.string().trim().min(1).max(100),
  fullName: z.string().trim().min(1).max(255),
  repoUrl: z.string().url('repoUrl must be a valid URL'),
  defaultBranch: z.string().trim().min(1).max(100).default('main'),
});

export const repositoryListQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1))
    .refine((val) => !isNaN(val) && val >= 1, 'Page must be an integer >= 1'),
  per_page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 30))
    .refine((val) => !isNaN(val) && val >= 1 && val <= 100, 'per_page must be between 1 and 100'),
});

export const callbackQuerySchema = z.object({
  installation_id: z.string({ required_error: 'installation_id query parameter is required' }),
  state: z.string({ required_error: 'state query parameter is required' }),
  setup_action: z.string().optional(),
});

export type LinkRepositoryInput = z.infer<typeof linkRepositorySchema>;

import { z } from 'zod';

// Safe workflow path pattern: allows "deploy.yml", "ci.yaml", or ".github/workflows/deploy.yml"
const safeWorkflowPathRegex = /^(\.github\/workflows\/)?[a-zA-Z0-9_\-.]+\.(ya?ml)$/;

// Git ref pattern: e.g. "main", "feature/abc", "v1.0.0", "refs/heads/main"
const safeGitRefRegex = /^(refs\/(heads|tags)\/)?[a-zA-Z0-9_\-./]+$/;

export const triggerPipelineSchema = z.object({
  workflowFile: z
    .string({ required_error: 'workflowFile is required' })
    .trim()
    .min(1, 'workflowFile cannot be empty')
    .max(100, 'workflowFile path is too long')
    .refine((val) => !val.includes('..') && !val.includes('\\'), {
      message: 'workflowFile path must not contain traversal characters (..) or backslashes',
    })
    .refine((val) => safeWorkflowPathRegex.test(val), {
      message:
        'workflowFile must be a valid YAML file name (e.g., "deploy.yml" or ".github/workflows/deploy.yml")',
    }),
  gitRef: z
    .string({ required_error: 'gitRef is required' })
    .trim()
    .min(1, 'gitRef cannot be empty')
    .max(255, 'gitRef is too long')
    .refine((val) => !val.includes('..') && !val.includes(' ') && !val.includes('//'), {
      message: 'gitRef must not contain traversal characters (..), double slashes, or spaces',
    })
    .refine((val) => safeGitRefRegex.test(val), {
      message: 'gitRef contains invalid characters for a Git branch or tag name',
    }),
  inputs: z
    .record(
      z
        .string()
        .regex(
          /^[a-zA-Z0-9_-]{1,50}$/,
          'Input names must be alphanumeric with underscores or hyphens'
        ),
      z.string().max(255, 'Input values cannot exceed 255 characters')
    )
    .optional()
    .refine(
      (inputs) => !inputs || Object.keys(inputs).length <= 15,
      'Maximum 15 workflow inputs allowed'
    ),
});

export const pipelineListQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1))
    .refine((val) => !isNaN(val) && val >= 1, 'Page must be an integer >= 1'),
  per_page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 20))
    .refine((val) => !isNaN(val) && val >= 1 && val <= 100, 'per_page must be between 1 and 100'),
});

export const pipelineIdParamSchema = z.string().uuid('Invalid pipeline ID format (UUID expected)');

export type TriggerPipelineInput = z.infer<typeof triggerPipelineSchema>;

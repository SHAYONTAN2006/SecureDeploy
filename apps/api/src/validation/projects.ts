import { z } from 'zod';

export const createProjectSchema = z.object({
  name: z
    .string({ required_error: 'Project name is required' })
    .trim()
    .min(1, 'Project name cannot be empty')
    .max(100, 'Project name must not exceed 100 characters'),
  description: z
    .string()
    .trim()
    .max(500, 'Description must not exceed 500 characters')
    .nullable()
    .optional(),
});

export const updateProjectSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Project name cannot be empty')
      .max(100, 'Project name must not exceed 100 characters')
      .optional(),
    description: z
      .string()
      .trim()
      .max(500, 'Description must not exceed 500 characters')
      .nullable()
      .optional(),
  })
  .refine((data) => data.name !== undefined || data.description !== undefined, {
    message: 'At least one field (name or description) must be provided for update',
  });

export const uuidParamSchema = z.string().uuid('Invalid project ID format (UUID expected)');

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

import * as projectsDb from '../db/projects.js';
import { type CreateProjectInput, type UpdateProjectInput } from '../validation/projects.js';

export async function createProjectForOwner(ownerId: string, input: CreateProjectInput) {
  return projectsDb.createProject({
    name: input.name,
    description: input.description,
    ownerId,
  });
}

export async function listProjectsForOwner(ownerId: string) {
  return projectsDb.findProjectsByOwnerId(ownerId);
}

export async function getProjectForOwner(id: string, ownerId: string) {
  return projectsDb.findProjectByIdAndOwner(id, ownerId);
}

export async function updateProjectForOwner(
  id: string,
  ownerId: string,
  input: UpdateProjectInput
) {
  return projectsDb.updateProjectByIdAndOwner(id, ownerId, {
    name: input.name,
    description: input.description,
  });
}

export async function deleteProjectForOwner(id: string, ownerId: string) {
  return projectsDb.deleteProjectByIdAndOwner(id, ownerId);
}

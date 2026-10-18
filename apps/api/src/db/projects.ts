import { prisma } from '../lib/prisma.js';

export interface CreateProjectData {
  name: string;
  description?: string | null;
  ownerId: string;
}

export interface UpdateProjectData {
  name?: string;
  description?: string | null;
}

export async function createProject(data: CreateProjectData) {
  return prisma.project.create({
    data: {
      name: data.name,
      description: data.description ?? null,
      ownerId: data.ownerId,
    },
  });
}

export async function findProjectById(id: string) {
  return prisma.project.findUnique({
    where: { id },
    include: {
      owner: true,
    },
  });
}

export async function findProjectByIdAndOwner(id: string, ownerId: string) {
  return prisma.project.findFirst({
    where: {
      id,
      ownerId,
    },
  });
}

export async function findProjectsByOwnerId(ownerId: string) {
  return prisma.project.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateProjectByIdAndOwner(
  id: string,
  ownerId: string,
  data: UpdateProjectData
) {
  const existing = await prisma.project.findFirst({
    where: { id, ownerId },
  });

  if (!existing) {
    return null;
  }

  return prisma.project.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
    },
  });
}

export async function deleteProjectByIdAndOwner(id: string, ownerId: string): Promise<boolean> {
  const result = await prisma.project.deleteMany({
    where: {
      id,
      ownerId,
    },
  });

  return result.count > 0;
}

export async function deleteProject(id: string) {
  return prisma.project.delete({
    where: { id },
  });
}

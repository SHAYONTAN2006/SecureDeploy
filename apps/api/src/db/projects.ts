import { prisma } from '../lib/prisma.js';

export interface CreateProjectData {
  name: string;
  description?: string;
  ownerId: string;
}

export async function createProject(data: CreateProjectData) {
  return prisma.project.create({
    data,
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

export async function findProjectsByOwnerId(ownerId: string) {
  return prisma.project.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function deleteProject(id: string) {
  return prisma.project.delete({
    where: { id },
  });
}

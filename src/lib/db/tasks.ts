import type { Task, TaskStatus } from '@/types';
import { db } from './schema';
import { createId } from './ids';

export type CreateTaskInput = {
  description: string;
  owner: string;
  source: string;
  assignedBy?: string;
  linkedTo?: string[];
  dueDate?: string;
  status?: TaskStatus;
  createdAt?: number;
};

export async function createTask(input: CreateTaskInput) {
  const task: Task = {
    id: createId('task'),
    description: input.description,
    owner: input.owner,
    assignedBy: input.assignedBy,
    linkedTo: input.linkedTo ?? [],
    dueDate: input.dueDate,
    status: input.status ?? 'pending',
    source: input.source,
    createdAt: input.createdAt ?? Date.now(),
  };

  await db.tasks.add(task);
  return task;
}

export function getTask(id: string) {
  return db.tasks.get(id);
}

export function listTasks() {
  return db.tasks.orderBy('createdAt').reverse().toArray();
}

export function listTasksByOwner(owner: string) {
  return db.tasks.where('owner').equals(owner).reverse().sortBy('createdAt');
}

export function listPendingTasksByOwner(owner: string) {
  return db.tasks
    .where('owner')
    .equals(owner)
    .filter((task) => task.status !== 'done' && task.status !== 'cancelled')
    .toArray();
}

export async function updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>) {
  await db.tasks.update(id, patch);
  return db.tasks.get(id);
}

export function completeTask(id: string) {
  return updateTask(id, { status: 'done', completedAt: Date.now() });
}

export function deleteTask(id: string) {
  return db.tasks.delete(id);
}

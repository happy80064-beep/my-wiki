import type { Entity } from '@/types';

export type QuerySource = {
  type: 'entity' | 'task' | 'entry';
  id: string;
  title: string;
  href?: string;
};

export type StructuredQueryResult = {
  answer: string;
  sources: QuerySource[];
  suggestions: string[];
  candidates?: Entity[];
};

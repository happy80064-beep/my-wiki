import type { CompileSuggestionRecord, Entity } from '@/types';

export type QuerySource = {
  type: 'entity' | 'task' | 'entry';
  id: string;
  title: string;
  href?: string;
};

export type QueryTraceStep = {
  layer: 'intent' | 'agent' | 'directory' | 'entity' | 'graph' | 'evidence' | 'answer';
  label: string;
  detail: string;
};

export type WikiCompileSuggestion = CompileSuggestionRecord;

export type StructuredQueryResult = {
  answer: string;
  sources: QuerySource[];
  suggestions: string[];
  candidates?: Entity[];
  trace?: QueryTraceStep[];
  compileSuggestions?: WikiCompileSuggestion[];
  llm?: {
    provider: 'minimax' | 'deepseek';
    model: string;
    fallbackFrom?: string;
  };
};

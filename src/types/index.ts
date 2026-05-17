export type ID = string;

export type EntrySource = 'text' | 'voice' | 'image' | 'file' | 'paste';

export type FileMetadata = {
  filename: string;
  mimeType: string;
  url: string;
  thumbnailUrl?: string;
};

export type Entry = {
  id: ID;
  clientId: string;
  content: string;
  source: EntrySource;
  fileMetadata?: FileMetadata;
  capturedAt: number;
  processed: boolean;
  derivedEntities: ID[];
  derivedTasks: ID[];
  derivedRelationships: ID[];
};

export type EntityType = 'person' | 'project' | 'event' | 'topic';
export type Scene = 'work' | 'life' | 'social' | 'personal';

export type PersonProps = {
  knownSince?: string;
  communicationStyle?: string;
  focusAreas?: string[];
  company?: string;
  role?: string;
  lastContactAt?: number;
  importantDates?: { label: string; date: string }[];
};

export type ProjectProps = {
  status: 'active' | 'paused' | 'done' | 'archived';
  goal?: string;
  startDate?: string;
  endDate?: string;
  myRole?: 'owner' | 'participant' | 'observer';
  retrospective?: {
    didWell?: string;
    toImprove?: string;
    reusableLessons?: string;
    completedAt?: number;
  };
};

export type EventProps = {
  occurredAt: number;
  location?: string;
  aiSummary?: string;
  rawTranscript?: string;
  decisions?: { content: string; decidedBy?: ID }[];
};

export type TopicProps = {
  isPersonal: boolean;
  myView?: string;
  viewHistory?: { view: string; updatedAt: number }[];
  autoCollectedSnippets: ID[];
};

export type EntityProperties = PersonProps | ProjectProps | EventProps | TopicProps;

export type EntityCategoryItem = {
  title: string;
  entityId?: ID;
  kind?: string;
  summary?: string;
  evidence?: string;
};

export type EntityCategory = {
  name: string;
  aliases?: string[];
  items: EntityCategoryItem[];
  evidence?: string;
  updatedAt: number;
};

export type IndicatorConfidence = 'high' | 'medium' | 'low';

export type EntityIndicator = {
  id: ID;
  name: string;
  value: number | null;
  rawValue?: string;
  unit?: string;
  businessLine?: string;
  categoryName?: string;
  categoryId?: string;
  source?: {
    entryId?: ID;
    section?: string;
    page?: number;
    excerpt?: string;
  };
  confidence: IndicatorConfidence;
  note?: string;
  asOfDate?: string;
  extractedAt: number;
  updatedAt: number;
};

export type BaseEntity<TType extends EntityType, TProps extends EntityProperties> = {
  id: ID;
  clientId: string;
  type: TType;
  title: string;
  summary: string;
  tags: string[];
  scenes: Scene[];
  properties: TProps;
  categories?: EntityCategory[];
  indicators?: EntityIndicator[];
  compiledProfile?: CompiledEntityProfile;
  wikiMarkdown?: string;
  wikiCompiledAt?: number;
  wikiCompileModel?: string;
  sourceEntries: ID[];
  createdAt: number;
  updatedAt: number;
};

export type PersonEntity = BaseEntity<'person', PersonProps>;
export type ProjectEntity = BaseEntity<'project', ProjectProps>;
export type EventEntity = BaseEntity<'event', EventProps>;
export type TopicEntity = BaseEntity<'topic', TopicProps>;
export type Entity = PersonEntity | ProjectEntity | EventEntity | TopicEntity;

export type CompiledEntityProfile = {
  overview: string;
  keyFacts: string[];
  openTasks: string[];
  relationshipSummary: string[];
  sourceSummary: string;
  updatedAt: number;
};

export type RelationshipType =
  | 'owner'
  | 'participant'
  | 'stakeholder'
  | 'decision-maker'
  | 'attendee'
  | 'organizer'
  | 'mentioned-in'
  | 'colleague'
  | 'friend'
  | 'family'
  | 'mentor'
  | 'reports-to'
  | 'parent-of'
  | 'depends-on'
  | 'related-to'
  | 'about'
  | 'kicked-off'
  | 'relevant-to'
  | 'mentions';

export type Relationship = {
  id: ID;
  clientId: string;
  from: ID;
  to: ID;
  type: RelationshipType;
  properties?: Record<string, unknown>;
  evidence: ID[];
  createdAt: number;
};

export type TaskStatus = 'pending' | 'done' | 'overdue' | 'cancelled';

export type Task = {
  id: ID;
  clientId: string;
  description: string;
  owner: ID;
  assignedBy?: ID;
  linkedTo: ID[];
  dueDate?: string;
  status: TaskStatus;
  completedAt?: number;
  source: ID;
  createdAt: number;
};

export type CompileSuggestionStatus = 'pending' | 'applied' | 'dismissed' | 'superseded';
export type CompileSuggestionEvidenceScope = 'entity-source' | 'global-fallback';

export type CompileSuggestionDraft = {
  entityId: ID;
  entityTitle: string;
  propertyKey: string;
  propertyLabel: string;
  propertyValue: string;
  businessLine?: string;
  categoryName?: string;
  categoryId?: string;
  evidenceEntryId: ID;
  evidenceSnippet: string;
  evidenceScope: CompileSuggestionEvidenceScope;
  confidence: number;
};

export type CompileSuggestionRecord = CompileSuggestionDraft & {
  id: ID;
  clientId: string;
  fingerprint: string;
  status: CompileSuggestionStatus;
  sourceQuestion?: string;
  createdAt: number;
  updatedAt: number;
  appliedAt?: number;
  dismissedAt?: number;
  supersededAt?: number;
};

export type IngestJobStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped';

export type IngestJob = {
  id: ID;
  clientId: string;
  content: string;
  source: EntrySource;
  filename?: string;
  targetEntryId?: ID;
  contentHash: string;
  status: IngestJobStatus;
  retryCount: number;
  error?: string;
  entryId?: ID;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type IngestCacheRecord = {
  contentHash: string;
  clientId: string;
  entryIds: ID[];
  createdAt: number;
  updatedAt: number;
};

export type GraphInsightDismissal = {
  id: ID;
  clientId: string;
  type: string;
  dismissedAt: number;
};

export type RawAssetKind = 'text' | 'word' | 'pdf' | 'image' | 'spreadsheet' | 'html' | 'presentation';

export type RawAssetStatus =
  | 'raw'
  | 'extracting'
  | 'compiling'
  | 'compiled'
  | 'skipped'
  | 'failed'
  | 'cancelled'
  | 'wiki_compiling'
  | 'wiki_failed';

export type RawAsset = {
  id: ID;
  clientId: string;
  filename: string;
  mimeType: string;
  kind: RawAssetKind;
  size: number;
  contentHash: string;
  blob: Blob;
  dataBase64?: string;
  status: RawAssetStatus;
  error?: string;
  extractedText?: string;
  ingestJobId?: ID;
  entryId?: ID;
  createdAt: number;
  updatedAt: number;
  compiledAt?: number;
};

export type QueryCacheRecord = {
  key: string;
  clientId: string;
  question: string;
  result: unknown;
  createdAt: number;
  updatedAt: number;
  dataUpdatedAt: number;
};

export type WikiBatchJobStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
export type WikiBatchJobItemStatus = 'pending' | 'running' | 'done' | 'failed';

export type WikiBatchJobItem = {
  entityId: ID;
  title: string;
  status: WikiBatchJobItemStatus;
  attempts: number;
  error?: string;
  startedAt?: number;
  updatedAt?: number;
  completedAt?: number;
};

export type WikiBatchJob = {
  id: ID;
  clientId: string;
  owner: string;
  status: WikiBatchJobStatus;
  items: WikiBatchJobItem[];
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  currentEntityId?: ID;
  currentTitle?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
};

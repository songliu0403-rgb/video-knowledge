import type { PluginHandlerContext } from '../../contracts/index.js';

export type VideoKnowledgeConnector = PluginHandlerContext['connector'] & {
  config?: Record<string, unknown>;
};

export type VideoKnowledgeRecord = {
  videoId: string;
  title: string;
  sourceUrl?: string;
  platformTitle?: string;
  uploader?: string;
  durationSeconds?: number;
  signalProfile?: Record<string, unknown>;
  timelineSegments: Array<Record<string, unknown>>;
  operationNotes: Array<Record<string, unknown>>;
  visibleTextEvidence: Array<Record<string, unknown>>;
  formulaOrCodeCandidates: Array<Record<string, unknown>>;
  gotchas: Array<Record<string, unknown>>;
  agentUsage?: Record<string, unknown>;
  videoValue?: Record<string, unknown>;
  keyScreenshots: Array<Record<string, unknown>>;
  transcript: {
    path?: string;
    preview: string[];
    invalidReason?: string;
  };
  paths: Record<string, string>;
};

export type SearchMatch = {
  kind: 'operation_note' | 'timeline' | 'transcript' | 'visible_text' | 'gotcha' | 'formula';
  title: string;
  summary?: string;
  evidenceRanges?: unknown;
  confidence?: unknown;
};

export type BilibiliFavoritesIndexSource = 'official' | 'partial';

export type BilibiliFavoritesCacheState = {
  enabled: boolean;
  forceRefresh: boolean;
  cachePath: string;
  cache: Record<string, unknown>;
  account: Record<string, unknown>;
  folders: Array<Record<string, unknown>>;
  now: () => string;
  stats: {
    pageHits: number;
    pageWrites: number;
  };
};

import { join } from 'node:path';
import type { PluginHandlerContext } from '../../contracts/index.js';
import { AppError } from '../../executor/app-error.js';
import {
  asObject,
  asObjectArray,
  normalizeInput,
  paginate,
  readJsonObject,
} from './common.js';
import {
  buildOrphanedBilibiliVideos,
  enrichBilibiliFavoriteVideosWithLocalState,
  filterLifecycleVideos,
  listOrphanedBilibiliVideos as buildOrphanedBilibiliVideosResult,
} from './local-video-index.js';
import { getCollectionsRootPath } from './paths.js';
import type { BilibiliFavoritesIndexSource, VideoKnowledgeConnector } from './types.js';
import { includesQuery } from './search.js';

export function getBilibiliFavoritesIndexPaths(connector: VideoKnowledgeConnector): Record<string, string> {
  const collectionsRootPath = getCollectionsRootPath(connector);

  return {
    officialIndexPath: join(collectionsRootPath, 'bilibili-favorites.json'),
    partialIndexPath: join(collectionsRootPath, 'bilibili-favorites.partial.json'),
    cachePath: join(collectionsRootPath, 'bilibili-favorites.sync-cache.json'),
  };
}

export function parseBilibiliFavoritesIndexSource(value: unknown): BilibiliFavoritesIndexSource | 'auto' {
  const normalized = normalizeInput(value).toLowerCase();

  if (!normalized) {
    return 'official';
  }

  if (normalized === 'official' || normalized === 'partial' || normalized === 'auto') {
    return normalized;
  }

  throw new AppError('validation_failed', 'Bilibili favorites index source must be official, partial, or auto.', {
    details: {
      source: value,
      acceptedSources: ['official', 'partial', 'auto'],
    },
  });
}

export function readBilibiliFavoritesIndex(
  connector: VideoKnowledgeConnector,
  requestedSource: unknown,
): Record<string, unknown> {
  const { officialIndexPath, partialIndexPath } = getBilibiliFavoritesIndexPaths(connector);
  const source = parseBilibiliFavoritesIndexSource(requestedSource);
  const candidates = source === 'auto'
    ? [
        { source: 'official' as const, path: officialIndexPath },
        { source: 'partial' as const, path: partialIndexPath },
      ]
    : [
        { source, path: source === 'partial' ? partialIndexPath : officialIndexPath },
      ];

  for (const candidate of candidates) {
    const index = readJsonObject(candidate.path);

    if (index) {
      return {
        index,
        source: candidate.source,
        indexPath: candidate.path,
        officialIndexPath,
        partialIndexPath,
      };
    }
  }

  throw new AppError('resource_not_found', 'Bilibili favorites index was not found. Run bilibili.favorites.sync first.', {
    details: {
      requestedSource: source,
      officialIndexPath,
      partialIndexPath,
    },
    statusCode: 404,
  });
}

export function getBilibiliFavoritesVideos(index: Record<string, unknown>): Array<Record<string, unknown>> {
  return asObjectArray(index.videos);
}

export function getBilibiliFavoritesFolders(index: Record<string, unknown>): Array<Record<string, unknown>> {
  return asObjectArray(index.folders);
}

function favoriteMatchesStatus(video: Record<string, unknown>, status: string): boolean {
  if (!status || status === 'all') {
    return true;
  }

  const ingestStatus = normalizeInput(video.ingestStatus).toLowerCase();
  const processingStatus = normalizeInput(video.processingStatus).toLowerCase();
  const favoriteStatus = normalizeInput(video.favoriteStatus).toLowerCase();

  if (status === 'processed') {
    return ingestStatus === 'done' || video.processingComplete === true;
  }

  return [ingestStatus, processingStatus, favoriteStatus].includes(status);
}

function filterBilibiliFavoriteVideos(
  videos: Array<Record<string, unknown>>,
  input: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const folderId = normalizeInput(input.folderId ?? input.mediaId);
  const status = normalizeInput(input.status).toLowerCase();

  return videos.filter((video) =>
    (!folderId || video.folderId === folderId) &&
    favoriteMatchesStatus(video, status),
  );
}

function buildBilibiliFavoritesResult(
  indexContext: Record<string, unknown>,
  videos: Array<Record<string, unknown>>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const index = indexContext.index as Record<string, unknown>;
  const page = paginate(videos, input);
  const syncOptions = asObject(index.syncOptions) ?? {};

  return {
    platform: 'bilibili',
    source: indexContext.source,
    indexPath: indexContext.indexPath,
    officialIndexPath: indexContext.officialIndexPath,
    partialIndexPath: indexContext.partialIndexPath,
    syncedAt: index.syncedAt,
    partial: syncOptions.partial === true || indexContext.source === 'partial',
    metadataOnly: true,
    contentEvidence: false,
    folders: getBilibiliFavoritesFolders(index),
    stats: index.stats,
    lifecycle: index.lifecycle,
    total: page.total,
    count: page.items.length,
    limit: page.limit,
    offset: page.offset,
    items: page.items,
  };
}

export function listBilibiliFavorites(
  input: Record<string, unknown>,
  context: PluginHandlerContext,
): Record<string, unknown> {
  const indexContext = readBilibiliFavoritesIndex(
    context.connector as VideoKnowledgeConnector,
    input.source ?? input.indexSource,
  );
  const videos = filterBilibiliFavoriteVideos(
    enrichBilibiliFavoriteVideosWithLocalState(
      getBilibiliFavoritesVideos(indexContext.index as Record<string, unknown>),
      context.connector as VideoKnowledgeConnector,
    ),
    input,
  );

  return buildBilibiliFavoritesResult(indexContext, videos, input);
}

export function searchBilibiliFavorites(
  input: Record<string, unknown>,
  context: PluginHandlerContext,
): Record<string, unknown> {
  const query = normalizeInput(input.query);

  if (!query) {
    throw new AppError('validation_failed', 'Bilibili favorites search query is required.', {
      details: { query: input.query },
    });
  }

  const indexContext = readBilibiliFavoritesIndex(
    context.connector as VideoKnowledgeConnector,
    input.source ?? input.indexSource,
  );
  const videos = filterBilibiliFavoriteVideos(
    enrichBilibiliFavoriteVideosWithLocalState(
      getBilibiliFavoritesVideos(indexContext.index as Record<string, unknown>),
      context.connector as VideoKnowledgeConnector,
    ),
    input,
  )
    .filter((video) => includesQuery(video, query));

  return {
    ...buildBilibiliFavoritesResult(indexContext, videos, input),
    query,
  };
}

export function listBilibiliFavoriteOrphans(
  input: Record<string, unknown>,
  context: PluginHandlerContext,
): Record<string, unknown> {
  const indexContext = readBilibiliFavoritesIndex(
    context.connector as VideoKnowledgeConnector,
    input.source ?? input.indexSource,
  );
  const currentFavorites = enrichBilibiliFavoriteVideosWithLocalState(
    getBilibiliFavoritesVideos(indexContext.index as Record<string, unknown>),
    context.connector as VideoKnowledgeConnector,
  );
  const result = buildOrphanedBilibiliVideosResult(currentFavorites, input, {
    connector: context.connector as VideoKnowledgeConnector,
  });
  const orphanedVideos = filterLifecycleVideos(
    buildOrphanedBilibiliVideos(context.connector as VideoKnowledgeConnector, currentFavorites),
    input,
  );

  return {
    ...result,
    source: indexContext.source,
    indexPath: indexContext.indexPath,
    officialIndexPath: indexContext.officialIndexPath,
    partialIndexPath: indexContext.partialIndexPath,
    syncedAt: asObject(indexContext.index)?.syncedAt,
    stats: {
      orphaned: orphanedVideos.length,
      processedOrphaned: orphanedVideos.filter((video) => video.processingComplete === true).length,
      localOnly: orphanedVideos.filter((video) => video.processingComplete !== true).length,
    },
  };
}

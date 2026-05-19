import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  asString,
  firstString,
  normalizeInput,
  paginate,
  readJsonObject,
  writeJsonFileAtomic,
} from './common.js';
import { getCollectionsRootPath, getVideoRootPath } from './paths.js';
import type { VideoKnowledgeConnector } from './types.js';

export type LocalVideoProcessingStatus =
  | 'not_started'
  | 'prepared'
  | 'captured'
  | 'transcribed'
  | 'visual_analyzed'
  | 'composed'
  | 'documented'
  | 'documented_variant';

type LocalVideoRecord = {
  platform: 'bilibili';
  videoKey: string;
  videoId: string;
  title?: string;
  sourceUrl?: string;
  processingStatus: LocalVideoProcessingStatus;
  ingestStatus: 'pending' | 'in_progress' | 'done';
  processingComplete: boolean;
  contentEvidence: boolean;
  workDir?: string;
  paths: Record<string, unknown>;
  variants?: Array<Record<string, unknown>>;
};

const bilibiliVideoIdPattern = /^BV[0-9A-Za-z]+$/;

export function getVideoLifecycleIndexPaths(connector: VideoKnowledgeConnector): Record<string, string> {
  const collectionsRootPath = getCollectionsRootPath(connector);

  return {
    processedVideoIndexPath: join(collectionsRootPath, 'processed-video-index.json'),
    videoCatalogPath: join(collectionsRootPath, 'video-catalog.json'),
  };
}

function filePathIfExists(filePath: string): string | undefined {
  return existsSync(filePath) ? filePath : undefined;
}

function directoryHasFiles(directoryPath: string, pattern?: RegExp): boolean {
  if (!existsSync(directoryPath)) {
    return false;
  }

  try {
    return readdirSync(directoryPath).some((fileName) => !pattern || pattern.test(fileName));
  } catch {
    return false;
  }
}

function listDocumentVariants(workDir: string): Array<Record<string, unknown>> {
  if (!existsSync(workDir)) {
    return [];
  }

  const reportSuffixes = new Set<string>();
  const evidenceSuffixes = new Set<string>();
  const manifestSuffixes = new Set<string>();

  for (const fileName of readdirSync(workDir)) {
    const reportMatch = /^video-report\.(.+)\.md$/i.exec(fileName);
    const evidenceMatch = /^video-evidence\.(.+)\.md$/i.exec(fileName);
    const manifestMatch = /^video-document-manifest\.(.+)\.json$/i.exec(fileName);

    if (reportMatch?.[1]) {
      reportSuffixes.add(reportMatch[1]);
    }
    if (evidenceMatch?.[1]) {
      evidenceSuffixes.add(evidenceMatch[1]);
    }
    if (manifestMatch?.[1]) {
      manifestSuffixes.add(manifestMatch[1]);
    }
  }

  return [...reportSuffixes]
    .filter((variant) => evidenceSuffixes.has(variant) && manifestSuffixes.has(variant))
    .map((variant) => ({
      variant,
      reportPath: join(workDir, `video-report.${variant}.md`),
      evidencePath: join(workDir, `video-evidence.${variant}.md`),
      documentManifestPath: join(workDir, `video-document-manifest.${variant}.json`),
      documentAssetsDir: filePathIfExists(join(workDir, `document-assets-${variant}`)),
    }));
}

function readSourceInfo(workDir: string): Record<string, unknown> {
  return readJsonObject(join(workDir, 'source.info.json')) ?? {};
}

export function getLocalVideoProcessingRecord(rootPath: string, videoId: string): LocalVideoRecord {
  const workDir = join(rootPath, videoId);

  if (!existsSync(workDir)) {
    return {
      platform: 'bilibili',
      videoKey: `bilibili:${videoId}`,
      videoId,
      processingStatus: 'not_started',
      ingestStatus: 'pending',
      processingComplete: false,
      contentEvidence: false,
      paths: {},
    };
  }

  const sourceInfo = readSourceInfo(workDir);
  const canonicalReportPath = filePathIfExists(join(workDir, 'video-report.md'));
  const canonicalEvidencePath = filePathIfExists(join(workDir, 'video-evidence.md'));
  const canonicalManifestPath = filePathIfExists(join(workDir, 'video-document-manifest.json'));
  const canonicalAssetsDir = filePathIfExists(join(workDir, 'document-assets'));
  const variants = listDocumentVariants(workDir);
  const transcriptPath = filePathIfExists(join(workDir, 'asr', 'transcript.txt'));
  const visualSummaryPath = filePathIfExists(join(workDir, 'keyframe_steps', 'keyframe-steps-summary.json'))
    ?? filePathIfExists(join(workDir, 'hard_subtitle_steps', 'hard-subtitle-steps-summary.json'));
  const bundlePath = filePathIfExists(join(workDir, 'qwen-style-video-analysis-bundle.json'));
  const safeNotesPath = filePathIfExists(join(workDir, 'hard-subtitle-operation-notes.safe.json'));
  const reportInsightsPath = filePathIfExists(join(workDir, 'video-report-insights.json'));
  const videoPath = filePathIfExists(join(workDir, 'video.mp4'));
  const probePath = filePathIfExists(join(workDir, 'probe.json'));
  const screenshotsDir = filePathIfExists(join(workDir, 'evidence_screenshots'));
  const hasScreenshots = directoryHasFiles(join(workDir, 'evidence_screenshots'), /\.(png|jpg|jpeg|webp)$/i);
  const canonicalComplete = Boolean(canonicalReportPath && canonicalEvidencePath && canonicalManifestPath && canonicalAssetsDir);
  const hasDocumentVariant = variants.length > 0;
  const processingStatus: LocalVideoProcessingStatus = (() => {
    if (canonicalComplete) {
      return 'documented';
    }
    if (hasDocumentVariant) {
      return 'documented_variant';
    }
    if (bundlePath || safeNotesPath || reportInsightsPath) {
      return 'composed';
    }
    if (visualSummaryPath) {
      return 'visual_analyzed';
    }
    if (transcriptPath) {
      return 'transcribed';
    }
    if (videoPath || probePath || hasScreenshots) {
      return 'captured';
    }
    return 'prepared';
  })();
  const processingComplete = processingStatus === 'documented' || processingStatus === 'documented_variant';
  const ingestStatus = processingComplete
    ? 'done'
    : 'in_progress';
  const contentEvidence = processingComplete || ['composed', 'visual_analyzed'].includes(processingStatus);

  return {
    platform: 'bilibili',
    videoKey: `bilibili:${videoId}`,
    videoId,
    title: firstString(sourceInfo.platform_title, sourceInfo.title, videoId),
    sourceUrl: firstString(sourceInfo.source_url, sourceInfo.webpage_url, `https://www.bilibili.com/video/${videoId}/`),
    processingStatus,
    ingestStatus,
    processingComplete,
    contentEvidence,
    workDir,
    paths: {
      workDir,
      reportPath: canonicalReportPath,
      evidencePath: canonicalEvidencePath,
      documentManifestPath: canonicalManifestPath,
      documentAssetsDir: canonicalAssetsDir,
      transcriptPath,
      visualSummaryPath,
      bundlePath,
      safeNotesPath,
      reportInsightsPath,
      videoPath,
      probePath,
      screenshotsDir,
    },
    ...(variants.length > 0 ? { variants } : {}),
  };
}

function listLocalBilibiliVideoIds(rootPath: string): string[] {
  if (!existsSync(rootPath)) {
    return [];
  }

  return readdirSync(rootPath)
    .map((entryName) => join(rootPath, entryName))
    .filter((entryPath) => {
      try {
        return statSync(entryPath).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entryPath) => basename(entryPath))
    .filter((entryName) => bilibiliVideoIdPattern.test(entryName));
}

export function buildProcessedVideoIndex(
  connector: VideoKnowledgeConnector,
  generatedAt?: string,
): Record<string, unknown> {
  const rootPath = getVideoRootPath(connector);
  const videos = listLocalBilibiliVideoIds(rootPath)
    .map((videoId) => getLocalVideoProcessingRecord(rootPath, videoId));
  const byStatus = videos.reduce<Record<string, number>>((counts, video) => {
    counts[video.processingStatus] = (counts[video.processingStatus] ?? 0) + 1;
    return counts;
  }, {});

  return {
    platform: 'local-video-processing',
    generatedAt,
    rootPath,
    videos,
    stats: {
      total: videos.length,
      done: videos.filter((video) => video.ingestStatus === 'done').length,
      inProgress: videos.filter((video) => video.ingestStatus === 'in_progress').length,
      byStatus,
    },
  };
}

export function writeProcessedVideoIndex(
  connector: VideoKnowledgeConnector,
  generatedAt: string,
): Record<string, unknown> {
  const { processedVideoIndexPath } = getVideoLifecycleIndexPaths(connector);
  const index = buildProcessedVideoIndex(connector, generatedAt);

  writeJsonFileAtomic(processedVideoIndexPath, index);
  return {
    ...index,
    indexPath: processedVideoIndexPath,
  };
}

function videoIdFromFavorite(video: Record<string, unknown>): string | undefined {
  return firstString(video.bvid, video.videoId, video.knowledgeVideoId);
}

function favoriteFolderFromVideo(video: Record<string, unknown>): Record<string, unknown> | undefined {
  const folderId = asString(video.folderId);
  const folderTitle = asString(video.folderTitle);

  if (!folderId && !folderTitle) {
    return undefined;
  }

  return {
    folderId,
    folderTitle,
  };
}

function buildFavoriteMemberships(videos: Array<Record<string, unknown>>): Map<string, Array<Record<string, unknown>>> {
  const memberships = new Map<string, Array<Record<string, unknown>>>();

  for (const video of videos) {
    const videoId = videoIdFromFavorite(video);
    const folder = favoriteFolderFromVideo(video);

    if (!videoId || !folder) {
      continue;
    }

    const folders = memberships.get(videoId) ?? [];
    const key = `${folder.folderId ?? ''}:${folder.folderTitle ?? ''}`;

    if (!folders.some((current) => `${current.folderId ?? ''}:${current.folderTitle ?? ''}` === key)) {
      folders.push(folder);
    }

    memberships.set(videoId, folders);
  }

  return memberships;
}

function processingRecordMap(connector: VideoKnowledgeConnector): Map<string, LocalVideoRecord> {
  const rootPath = getVideoRootPath(connector);
  const records = listLocalBilibiliVideoIds(rootPath)
    .map((videoId) => getLocalVideoProcessingRecord(rootPath, videoId));

  return new Map(records.map((record) => [record.videoId, record]));
}

export function enrichBilibiliFavoriteVideosWithLocalState(
  videos: Array<Record<string, unknown>>,
  connector: VideoKnowledgeConnector,
): Array<Record<string, unknown>> {
  const rootPath = getVideoRootPath(connector);
  const processing = processingRecordMap(connector);
  const memberships = buildFavoriteMemberships(videos);

  return videos.map((video) => {
    const videoId = videoIdFromFavorite(video);
    const local = videoId
      ? processing.get(videoId) ?? getLocalVideoProcessingRecord(rootPath, videoId)
      : undefined;

    return {
      ...video,
      ...(videoId ? { knowledgeVideoId: videoId, videoKey: `bilibili:${videoId}` } : {}),
      favoriteStatus: 'active_favorite',
      currentFavoriteFolders: videoId ? memberships.get(videoId) ?? [] : [],
      availabilityStatus: 'unknown',
      ...(local
        ? {
            ingestStatus: local.ingestStatus,
            processingStatus: local.processingStatus,
            processingComplete: local.processingComplete,
            contentEvidence: local.contentEvidence,
            localPaths: local.paths,
            localVariants: local.variants ?? [],
          }
        : {}),
    };
  });
}

export function buildOrphanedBilibiliVideos(
  connector: VideoKnowledgeConnector,
  currentFavoriteVideos: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const currentFavoriteVideoIds = new Set(
    currentFavoriteVideos
      .map(videoIdFromFavorite)
      .filter((videoId): videoId is string => Boolean(videoId)),
  );

  return [...processingRecordMap(connector).values()]
    .filter((record) => !currentFavoriteVideoIds.has(record.videoId))
    .map((record) => ({
      platform: 'bilibili',
      videoKey: record.videoKey,
      videoId: record.videoId,
      bvid: record.videoId,
      url: record.sourceUrl ?? `https://www.bilibili.com/video/${record.videoId}/`,
      title: record.title ?? record.videoId,
      favoriteStatus: 'not_in_current_favorites',
      currentFavoriteFolders: [],
      orphanReason: record.processingComplete
        ? 'processed_unfavorited_or_source_removed'
        : 'local_only_not_in_current_favorites',
      availabilityStatus: 'unknown',
      ingestStatus: record.ingestStatus,
      processingStatus: record.processingStatus,
      processingComplete: record.processingComplete,
      contentEvidence: record.contentEvidence,
      localPaths: record.paths,
      localVariants: record.variants ?? [],
    }));
}

function lifecycleMatchesStatus(video: Record<string, unknown>, status: string): boolean {
  if (!status || status === 'all') {
    return true;
  }

  const ingestStatus = normalizeInput(video.ingestStatus).toLowerCase();
  const processingStatus = normalizeInput(video.processingStatus).toLowerCase();
  const favoriteStatus = normalizeInput(video.favoriteStatus).toLowerCase();
  const orphanReason = normalizeInput(video.orphanReason).toLowerCase();
  const availabilityStatus = normalizeInput(video.availabilityStatus).toLowerCase();

  if (status === 'processed') {
    return ingestStatus === 'done' || video.processingComplete === true;
  }

  if (status === 'orphan' || status === 'orphaned') {
    return favoriteStatus === 'not_in_current_favorites';
  }

  return [ingestStatus, processingStatus, favoriteStatus, orphanReason, availabilityStatus].includes(status);
}

export function filterLifecycleVideos(
  videos: Array<Record<string, unknown>>,
  input: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const status = normalizeInput(input.status ?? input.lifecycleStatus).toLowerCase();

  return videos.filter((video) => lifecycleMatchesStatus(video, status));
}

export function buildVideoCatalog(
  connector: VideoKnowledgeConnector,
  favoriteVideos: Array<Record<string, unknown>>,
  generatedAt: string,
): Record<string, unknown> {
  const activeFavoriteVideos = enrichBilibiliFavoriteVideosWithLocalState(favoriteVideos, connector);
  const orphanedVideos = buildOrphanedBilibiliVideos(connector, activeFavoriteVideos);

  return {
    platform: 'bilibili',
    generatedAt,
    activeFavoriteVideos,
    orphanedVideos,
    items: [...activeFavoriteVideos, ...orphanedVideos],
    stats: {
      activeFavorites: activeFavoriteVideos.length,
      orphaned: orphanedVideos.length,
      processedOrphaned: orphanedVideos.filter((video) => video.processingComplete === true).length,
      localOnly: orphanedVideos.filter((video) => video.processingComplete !== true).length,
    },
  };
}

export function writeVideoCatalog(
  connector: VideoKnowledgeConnector,
  favoriteVideos: Array<Record<string, unknown>>,
  generatedAt: string,
): Record<string, unknown> {
  const { videoCatalogPath } = getVideoLifecycleIndexPaths(connector);
  const catalog = buildVideoCatalog(connector, favoriteVideos, generatedAt);

  writeJsonFileAtomic(videoCatalogPath, catalog);
  return {
    ...catalog,
    catalogPath: videoCatalogPath,
  };
}

export function listOrphanedBilibiliVideos(
  currentFavoriteVideos: Array<Record<string, unknown>>,
  input: Record<string, unknown>,
  context: { connector: VideoKnowledgeConnector },
): Record<string, unknown> {
  const videos = filterLifecycleVideos(
    buildOrphanedBilibiliVideos(context.connector, currentFavoriteVideos),
    input,
  );
  const page = paginate(videos, input);

  return {
    platform: 'bilibili',
    source: 'local_lifecycle',
    metadataOnly: true,
    contentEvidence: false,
    total: page.total,
    count: page.items.length,
    limit: page.limit,
    offset: page.offset,
    items: page.items,
    guidance: 'Orphaned videos are local video artifacts that are not present in the current favorites snapshot. Do not delete them unless the user explicitly asks.',
  };
}

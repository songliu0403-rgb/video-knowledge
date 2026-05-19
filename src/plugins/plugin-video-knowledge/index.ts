import type { PluginModule } from '../../contracts/index.js';
import { AppError } from '../../executor/app-error.js';
import { asObject, asObjectArray, extractBilibiliVideoId, firstString, isUsableTranscriptText, normalizeInput, parseBoolean, readJsonObject, readTextFile, transcriptInvalidReason, valueToNumber } from './common.js';
import { listBilibiliFavoriteOrphans, listBilibiliFavorites, searchBilibiliFavorites } from './favorites-index.js';
import { listCurrentBilibiliFavoriteFolders, syncBilibiliFavorites } from './favorites-sync.js';
import {
  analyzeVisualVideoEvidence,
  buildFullPipelineEnvironmentPreflight,
  captureLocalVideoEvidence,
  composeVideoEvidenceBundle,
  composeVideoEvidenceDocument,
  enqueueVideoIngestion,
  processNextVideoIngestion,
  transcribeLocalVideoEvidence,
} from './ingest-queue.js';
import { checkVideoKnowledgeEnvironment, checkVideoKnowledgeEnvironmentRequirements } from './environment.js';
import { findVideoById, includesQuery, toSearchMatches, toSearchResult } from './search.js';
import type { VideoKnowledgeConnector } from './types.js';
import { loadVideos } from './video-bundle-loader.js';

function siblingPath(path: string | undefined, name: string): string | undefined {
  if (!path) {
    return undefined;
  }

  const separator = path.includes('\\') ? '\\' : '/';
  const index = path.lastIndexOf(separator);

  if (index === -1) {
    return name;
  }

  return `${path.slice(0, index)}${separator}${name}`;
}

function isProcessedVideo(video: ReturnType<typeof loadVideos>[number]): boolean {
  return Boolean(video.paths.reportPath && video.paths.evidencePath && video.paths.documentManifestPath);
}

function getPartialVideoStage(video: ReturnType<typeof loadVideos>[number]): string {
  if (video.paths.reportPath || video.paths.evidencePath || video.paths.documentManifestPath) {
    return 'document_partial';
  }

  if (video.operationNotes.length > 0 || video.visibleTextEvidence.length > 0 || video.formulaOrCodeCandidates.length > 0) {
    return 'visual_analyzed';
  }

  if (video.transcript.path) {
    return 'transcribed';
  }

  if (video.keyScreenshots.length > 0) {
    return 'captured';
  }

  return 'prepared';
}

function countNonEmptyLines(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }

  return text.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0).length;
}

function withoutUndefined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

function buildTranscriptStatus(
  video: ReturnType<typeof loadVideos>[number],
  documentManifest: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const transcriptPath = firstString(
    documentManifest?.transcriptTextPath,
    documentManifest?.transcriptPath,
    video.paths.transcriptPath,
    video.transcript.path,
  );
  const transcriptText = transcriptPath ? readTextFile(transcriptPath) : undefined;
  const invalidReason = transcriptInvalidReason(transcriptText) ?? video.transcript.invalidReason;
  const exists = isUsableTranscriptText(transcriptText);

  return withoutUndefined({
    exists,
    path: transcriptPath,
    lineCount: exists ? countNonEmptyLines(transcriptText) : undefined,
    preview: exists ? video.transcript.preview.slice(0, 3) : [],
    invalid: invalidReason ? true : undefined,
    invalidReason,
    guidance: 'Use this structured transcript path and lineCount; do not infer ASR status or line count from video-evidence.md text.',
  });
}

function buildKeyframeSelectionStatus(
  documentManifest: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const documentSelection = asObject(documentManifest?.keyframeSelection);
  const manifestPath = firstString(
    documentSelection?.manifestPath,
    documentSelection?.keyframeManifestPath,
    documentManifest?.keyframeManifestPath,
  );
  const keyframeManifest = manifestPath ? readJsonObject(manifestPath) : undefined;
  const selectedCount = valueToNumber(documentSelection?.selectedCount) ?? valueToNumber(keyframeManifest?.selectedCount);
  const semanticMinScore = valueToNumber(keyframeManifest?.semanticMinScore);
  const semanticWindowSeconds = valueToNumber(keyframeManifest?.semanticWindowSeconds);
  const maxFramesPerMinute = valueToNumber(keyframeManifest?.maxFramesPerMinute);
  const preset = manifestPath?.toLowerCase().includes('semantic-tight') ? 'semantic-tight' : undefined;
  const status = withoutUndefined({
    preset,
    source: firstString(documentSelection?.source, keyframeManifest?.source),
    manifestPath,
    strategy: firstString(documentSelection?.strategy, keyframeManifest?.strategy),
    algorithm: firstString(documentSelection?.algorithm, keyframeManifest?.algorithm),
    selectedCount,
    usableScreenshots: valueToNumber(documentSelection?.usableScreenshots),
    semanticSignalCount: valueToNumber(keyframeManifest?.semanticSignalCount),
    semanticMinScore,
    semanticWindowSeconds,
    semanticWeight: valueToNumber(keyframeManifest?.semanticWeight),
    maxFramesPerMinute,
    diffThreshold: valueToNumber(keyframeManifest?.diffThreshold),
    targetIntervalSeconds: valueToNumber(keyframeManifest?.targetIntervalSeconds),
    answerFields: withoutUndefined({
      selectedCount,
      'semantic-min-score': semanticMinScore,
      'max-frames-per-minute': maxFramesPerMinute,
      'semantic-window-seconds': semanticWindowSeconds,
      'keyframe manifest path': manifestPath,
    }),
    guidance: manifestPath
      ? 'Use answerFields for screenshot strategy questions. max-frames-per-minute is the configured cap, not actual average density; do not compute or substitute another value.'
      : undefined,
  });

  return Object.keys(status).length > 0 ? status : undefined;
}

function toVideoKnowledgeStatus(videoId: string, connector: VideoKnowledgeConnector): Record<string, unknown> {
  const video = findVideoById(loadVideos(connector), videoId);

  if (!video) {
    return {
      ok: false,
      status: 'not_processed',
      videoId,
      guidance: 'No processed evidence exists for this exact video id. Do not summarize it and do not construct report paths by convention; ask whether to enqueue/process it.',
    };
  }

  if (!isProcessedVideo(video)) {
    return {
      ok: false,
      status: 'in_progress',
      stage: getPartialVideoStage(video),
      videoId: video.videoId,
      title: video.title,
      sourceUrl: video.sourceUrl,
      partialEvidence: {
        transcriptPath: video.transcript.path,
        screenshotCount: video.keyScreenshots.length,
      },
      guidance: 'This video has partial processing artifacts but no complete video-report.md/video-evidence.md yet. Do not present a final video summary or construct report paths; continue the ingestion pipeline.',
    };
  }

  const reportPath = video.paths.reportPath;
  const documentManifest = video.paths.documentManifestPath
    ? readJsonObject(video.paths.documentManifestPath)
    : undefined;
  const keyframeSelection = buildKeyframeSelectionStatus(documentManifest);
  const transcript = buildTranscriptStatus(video, documentManifest);
  const commonPaths = {
    reportPath,
    evidencePath: video.paths.evidencePath,
    documentManifestPath: video.paths.documentManifestPath,
    documentAssetsDir: firstString(
      video.paths.documentAssetsDir,
      documentManifest?.documentAssetsDir,
      documentManifest?.assetsDirectory,
    ) ?? siblingPath(reportPath, 'document-assets'),
  };

  if (transcript.invalid === true) {
    return {
      ok: false,
      status: 'processed_invalid_transcript',
      videoId: video.videoId,
      title: video.title,
      sourceUrl: video.sourceUrl,
      paths: commonPaths,
      transcript,
      qualityWarnings: [
        'transcript appears to contain an error traceback instead of ASR text; rerun transcription with force and regenerate the report before treating this video as processed.',
      ],
      guidance: 'Report files exist, but transcript evidence is invalid. Do not treat this as a completed video report until ASR is repaired or explicitly marked unavailable.',
    };
  }

  return {
    ok: true,
    status: 'processed',
    videoId: video.videoId,
    title: video.title,
    sourceUrl: video.sourceUrl,
    paths: commonPaths,
    transcript,
    ...(keyframeSelection ? { keyframeSelection } : {}),
    guidance: 'Only report paths present in this response or verified files. Use structured transcript/keyframe fields from this response or the document manifest; do not infer them from prose or invent paths for other video ids.',
  };
}

function fullPipelineTargetVideoId(input: Record<string, unknown>): string | undefined {
  return firstString(input.videoId, input.bvid)
    ?? extractBilibiliVideoId(input.url ?? input.sourceUrl);
}

function runFullPipelineStep(
  stage: string,
  run: () => Record<string, unknown>,
): Record<string, unknown> {
  try {
    return run();
  } catch (error) {
    throw new AppError('connector_unavailable', `Full video ingestion failed at ${stage}.`, {
      details: {
        stage,
        cause: error instanceof AppError ? error.toJSON() : error instanceof Error ? error.message : String(error),
      },
      statusCode: error instanceof AppError ? error.statusCode : 500,
    });
  }
}

function blockedFullPipelineResult(
  input: {
    videoId?: string;
    stage: string;
    reason: string;
    steps: Record<string, unknown>;
    finalCheck?: Record<string, unknown>;
  },
): Record<string, unknown> {
  return {
    outcome: 'blocked',
    selected: Boolean(input.videoId),
    videoId: input.videoId,
    blockedAt: input.stage,
    reason: input.reason,
    steps: input.steps,
    ...(input.finalCheck ? { finalCheck: input.finalCheck } : {}),
    guidance: 'Do not claim the video is processed. Report blockedAt/reason and continue only after the missing prerequisite is fixed.',
  };
}

function processFullVideoIngestion(input: Record<string, unknown>, context: Parameters<typeof processNextVideoIngestion>[1]): Record<string, unknown> {
  const connector = context.connector as VideoKnowledgeConnector;
  const steps: Record<string, unknown> = {};
  const requestedVideoId = fullPipelineTargetVideoId(input);
  const initialInput = {
    ...input,
    ...(requestedVideoId ? { videoId: requestedVideoId } : {}),
  };

  let processNext = runFullPipelineStep('process-next', () => processNextVideoIngestion(initialInput, context));
  steps.processNext = processNext;

  if (processNext.selected !== true && !requestedVideoId) {
    return blockedFullPipelineResult({
      stage: 'process-next',
      reason: firstString(processNext.outcome) ?? 'no_queued_job',
      steps,
    });
  }

  if (processNext.selected !== true && requestedVideoId) {
    const beforeEnqueueCheck = toVideoKnowledgeStatus(requestedVideoId, connector);

    if (!parseBoolean(input.force, false) && beforeEnqueueCheck.ok === true) {
      return {
        outcome: 'processed',
        selected: true,
        videoId: requestedVideoId,
        steps,
        finalCheck: beforeEnqueueCheck,
        guidance: 'Only report completion when finalCheck.ok is true. This video already had verified report artifacts.',
      };
    }

    const enqueue = runFullPipelineStep('enqueue', () => enqueueVideoIngestion(initialInput, context));
    steps.enqueue = enqueue;

    const processNextAfterEnqueue = runFullPipelineStep('process-next', () => processNextVideoIngestion(initialInput, context));
    steps.processNextAfterEnqueue = processNextAfterEnqueue;

    if (processNextAfterEnqueue.selected === true) {
      processNext = processNextAfterEnqueue;
    }
  }

  const videoId = firstString(asObject(processNext.job)?.videoId, requestedVideoId);

  if (!videoId) {
    throw new AppError('validation_failed', 'Full video ingestion could not determine the selected video id.', {
      details: {
        processNext,
      },
    });
  }

  const stageInput = {
    ...input,
    videoId,
  };
  const beforeCaptureCheck = toVideoKnowledgeStatus(videoId, connector);

  if (!parseBoolean(input.force, false) && beforeCaptureCheck.ok === true) {
    return {
      outcome: 'processed',
      selected: true,
      videoId,
      steps,
      finalCheck: beforeCaptureCheck,
      guidance: 'Only report completion when finalCheck.ok is true. This video already had verified report artifacts.',
    };
  }

  const fullPreflight = buildFullPipelineEnvironmentPreflight(stageInput, connector, videoId);
  const environmentCheck = checkVideoKnowledgeEnvironmentRequirements(connector, fullPreflight.requirements, {
    scope: 'process-full',
    strict: true,
  });
  steps.environmentCheck = {
    ...environmentCheck,
    plan: fullPreflight.plan,
  };

  if (environmentCheck.ok !== true) {
    return blockedFullPipelineResult({
      videoId,
      stage: 'environment-check',
      reason: firstString(asObjectArray(environmentCheck.checks).find((check) => asObject(check)?.ok === false)?.code)
        ?? 'environment_unavailable',
      steps,
      finalCheck: toVideoKnowledgeStatus(videoId, connector),
    });
  }

  const captureLocal = runFullPipelineStep('capture-local', () => captureLocalVideoEvidence(stageInput, context));
  steps.captureLocal = captureLocal;

  if (captureLocal.mediaEvidence !== true) {
    return blockedFullPipelineResult({
      videoId,
      stage: 'capture-local',
      reason: firstString(captureLocal.outcome) ?? 'media_evidence_missing',
      steps,
      finalCheck: toVideoKnowledgeStatus(videoId, connector),
    });
  }

  const transcribeLocal = runFullPipelineStep('transcribe-local', () => transcribeLocalVideoEvidence(stageInput, context));
  steps.transcribeLocal = transcribeLocal;

  const analyzeVisual = runFullPipelineStep('analyze-visual', () => analyzeVisualVideoEvidence(stageInput, context));
  steps.analyzeVisual = analyzeVisual;

  if (analyzeVisual.visualEvidence !== true) {
    return blockedFullPipelineResult({
      videoId,
      stage: 'analyze-visual',
      reason: firstString(analyzeVisual.outcome) ?? 'visual_evidence_missing',
      steps,
      finalCheck: toVideoKnowledgeStatus(videoId, connector),
    });
  }

  const composeBundle = runFullPipelineStep('compose-bundle', () => composeVideoEvidenceBundle(stageInput, context));
  steps.composeBundle = composeBundle;

  if (composeBundle.contentEvidence !== true) {
    return blockedFullPipelineResult({
      videoId,
      stage: 'compose-bundle',
      reason: firstString(composeBundle.outcome) ?? 'content_evidence_missing',
      steps,
      finalCheck: toVideoKnowledgeStatus(videoId, connector),
    });
  }

  const composeDocument = runFullPipelineStep('compose-document', () => composeVideoEvidenceDocument(stageInput, context));
  steps.composeDocument = composeDocument;

  const finalCheck = toVideoKnowledgeStatus(videoId, connector);

  if (finalCheck.ok !== true) {
    return blockedFullPipelineResult({
      videoId,
      stage: 'final-check',
      reason: 'check-video did not return ok=true after compose-document',
      steps,
      finalCheck,
    });
  }

  return {
    outcome: 'processed',
    selected: true,
    videoId,
    steps,
    finalCheck,
    guidance: 'Only report completion when finalCheck.ok is true. Use finalCheck.paths for report/evidence/manifest/assets paths.',
  };
}

export const pluginVideoKnowledgeModule: PluginModule = {
  manifest: {
    pluginId: 'plugin.video-knowledge',
    version: '0.1.0',
    capabilities: [
      {
        capabilityId: 'video.knowledge.search',
        pluginId: 'plugin.video-knowledge',
        summary: 'Search processed video knowledge, transcript snippets, and visual evidence.',
        category: 'read',
        sideEffectLevel: 'none',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          query: { type: 'string', description: 'Search text', required: true },
          videoId: { type: 'string', description: 'Optional video id to limit the search', required: false },
        },
        resultType: 'resource_list',
        resourceRef: 'resource.video_knowledge',
        nextCapabilities: ['video.knowledge.get'],
      },
      {
        capabilityId: 'video.knowledge.get',
        pluginId: 'plugin.video-knowledge',
        summary: 'Get a processed video evidence bundle by video id.',
        category: 'read',
        sideEffectLevel: 'none',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          videoId: { type: 'string', description: 'Video id', required: true },
        },
        resultType: 'resource',
        resourceRef: 'resource.video_knowledge',
        nextCapabilities: [],
      },
      {
        capabilityId: 'video.knowledge.check',
        pluginId: 'plugin.video-knowledge',
        summary: 'Check whether a video has processed evidence and verified report paths without inventing paths.',
        category: 'read',
        sideEffectLevel: 'none',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          videoId: { type: 'string', description: 'Video id to verify', required: true },
        },
        resultType: 'resource',
        resourceRef: 'resource.video_knowledge_status',
        nextCapabilities: ['video.ingest.enqueue', 'video.knowledge.get'],
      },
      {
        capabilityId: 'video.environment.check',
        pluginId: 'plugin.video-knowledge',
        summary: 'Check local video pipeline prerequisites before capture, ASR, visual analysis, or batch processing.',
        category: 'read',
        sideEffectLevel: 'none',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          scope: { type: 'string', description: 'Environment scope: full, capture, transcribe, visual, or document. Defaults to full.', required: false },
          strict: { type: 'string', description: 'When true, transient temp executables such as /tmp/ffmpeg fail the check.', required: false },
          provider: { type: 'string', description: 'ASR provider for transcription checks: gemini, kimi, api, or whisper.', required: false },
          asrProvider: { type: 'string', description: 'Alias for provider.', required: false },
          download: { type: 'string', description: 'Whether capture needs yt-dlp. Defaults to true for capture/full checks.', required: false },
          probe: { type: 'string', description: 'Whether capture needs ffprobe. Defaults to true for capture/full checks.', required: false },
          keyframes: { type: 'string', description: 'Whether capture needs ffmpeg screenshot extraction. Defaults to true for capture/full checks.', required: false },
          transcriptionScriptPath: { type: 'string', description: 'Optional API transcription script path.', required: false },
          scriptPath: { type: 'string', description: 'Optional visual analysis script path; also accepted by transcription providers when relevant.', required: false },
          pythonPath: { type: 'string', description: 'Optional Python executable path for API scripts.', required: false },
          autoKeyframeSelection: { type: 'string', description: 'Whether document generation needs automatic keyframe selection. Defaults to true.', required: false },
          keyframeSelectorScriptPath: { type: 'string', description: 'Optional select_keyframes.py path.', required: false },
        },
        resultType: 'resource',
        resourceRef: 'resource.video_environment',
        nextCapabilities: ['video.ingest.process-full'],
      },
      {
        capabilityId: 'bilibili.favorites.sync',
        pluginId: 'plugin.video-knowledge',
        summary: 'Sync Bilibili favorite folders and video URLs into the local video knowledge collection index.',
        category: 'command',
        sideEffectLevel: 'reversible',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          folderId: { type: 'string', description: 'Optional Bilibili favorite folder media id to sync', required: false },
          mediaId: { type: 'string', description: 'Alias for folderId', required: false },
          limit: { type: 'string', description: 'Maximum videos to sync across selected folders', required: false },
          delayMs: { type: 'string', description: 'Delay between paginated Bilibili API requests in milliseconds', required: false },
          resume: { type: 'string', description: 'Whether to reuse page-level sync cache. Defaults to true.', required: false },
          forceRefresh: { type: 'string', description: 'Ignore cached pages and refetch from Bilibili when true.', required: false },
          cache: { type: 'string', description: 'Whether to write/read the local sync cache. Defaults to true.', required: false },
        },
        resultType: 'resource',
        resourceRef: 'resource.bilibili_favorites',
        nextCapabilities: ['bilibili.favorites.list', 'bilibili.favorites.orphans', 'video.knowledge.search'],
      },
      {
        capabilityId: 'bilibili.favorites.folders',
        pluginId: 'plugin.video-knowledge',
        summary: 'List current Bilibili favorite folders and video counts without listing folder videos.',
        category: 'read',
        sideEffectLevel: 'none',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          folderId: { type: 'string', description: 'Optional Bilibili favorite folder media id to fetch', required: false },
          mediaId: { type: 'string', description: 'Alias for folderId', required: false },
        },
        resultType: 'resource_list',
        resourceRef: 'resource.bilibili_favorite_folders',
        nextCapabilities: ['bilibili.favorites.sync', 'bilibili.favorites.list', 'bilibili.favorites.orphans'],
      },
      {
        capabilityId: 'bilibili.favorites.list',
        pluginId: 'plugin.video-knowledge',
        summary: 'List locally indexed Bilibili favorite videos without calling Bilibili APIs.',
        category: 'read',
        sideEffectLevel: 'none',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          source: { type: 'string', description: 'Index source: official, partial, or auto. Defaults to official.', required: false },
          indexSource: { type: 'string', description: 'Alias for source', required: false },
          folderId: { type: 'string', description: 'Optional favorite folder media id filter', required: false },
          mediaId: { type: 'string', description: 'Alias for folderId', required: false },
          status: { type: 'string', description: 'Optional ingest status filter, such as pending or done', required: false },
          limit: { type: 'string', description: 'Maximum videos to return', required: false },
          offset: { type: 'string', description: 'Pagination offset', required: false },
        },
        resultType: 'resource_list',
        resourceRef: 'resource.bilibili_favorites',
        nextCapabilities: ['bilibili.favorites.search', 'bilibili.favorites.orphans', 'video.knowledge.search'],
      },
      {
        capabilityId: 'bilibili.favorites.search',
        pluginId: 'plugin.video-knowledge',
        summary: 'Search locally indexed Bilibili favorite video metadata without treating titles as content evidence.',
        category: 'read',
        sideEffectLevel: 'none',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          query: { type: 'string', description: 'Metadata search query', required: true },
          source: { type: 'string', description: 'Index source: official, partial, or auto. Defaults to official.', required: false },
          indexSource: { type: 'string', description: 'Alias for source', required: false },
          folderId: { type: 'string', description: 'Optional favorite folder media id filter', required: false },
          mediaId: { type: 'string', description: 'Alias for folderId', required: false },
          status: { type: 'string', description: 'Optional ingest status filter, such as pending or done', required: false },
          limit: { type: 'string', description: 'Maximum videos to return', required: false },
          offset: { type: 'string', description: 'Pagination offset', required: false },
        },
        resultType: 'resource_list',
        resourceRef: 'resource.bilibili_favorites',
        nextCapabilities: ['video.knowledge.search', 'video.knowledge.get'],
      },
      {
        capabilityId: 'bilibili.favorites.orphans',
        pluginId: 'plugin.video-knowledge',
        summary: 'List local Bilibili video artifacts that are not in the current favorites snapshot.',
        category: 'read',
        sideEffectLevel: 'none',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          source: { type: 'string', description: 'Index source: official, partial, or auto. Defaults to official.', required: false },
          indexSource: { type: 'string', description: 'Alias for source', required: false },
          status: { type: 'string', description: 'Optional lifecycle status filter, such as done, in_progress, orphan, documented, or documented_variant.', required: false },
          lifecycleStatus: { type: 'string', description: 'Alias for status.', required: false },
          limit: { type: 'string', description: 'Maximum videos to return', required: false },
          offset: { type: 'string', description: 'Pagination offset', required: false },
        },
        resultType: 'resource_list',
        resourceRef: 'resource.bilibili_favorite_orphans',
        nextCapabilities: ['video.knowledge.check', 'video.knowledge.get'],
      },
      {
        capabilityId: 'video.ingest.enqueue',
        pluginId: 'plugin.video-knowledge',
        summary: 'Add a video URL or Bilibili BV id to the local video ingestion queue.',
        category: 'command',
        sideEffectLevel: 'reversible',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          videoId: { type: 'string', description: 'Video id, such as a Bilibili BV id', required: false },
          bvid: { type: 'string', description: 'Alias for videoId when the source is Bilibili', required: false },
          url: { type: 'string', description: 'Source video URL', required: false },
          sourceUrl: { type: 'string', description: 'Alias for url', required: false },
          title: { type: 'string', description: 'Optional title when the video is not found in local metadata', required: false },
          platform: { type: 'string', description: 'Optional source platform. Defaults to bilibili for BV ids.', required: false },
          priority: { type: 'string', description: 'Queue priority, such as normal or high', required: false },
          reason: { type: 'string', description: 'Why this video should be ingested', required: false },
          note: { type: 'string', description: 'Alias for reason', required: false },
        },
        resultType: 'resource',
        resourceRef: 'resource.video_ingest_queue',
        nextCapabilities: ['video.ingest.process-next', 'bilibili.favorites.search', 'video.knowledge.search'],
      },
      {
        capabilityId: 'video.ingest.process-next',
        pluginId: 'plugin.video-knowledge',
        summary: 'Prepare the next queued video ingestion job for the local compiler pipeline.',
        category: 'command',
        sideEffectLevel: 'reversible',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          videoId: { type: 'string', description: 'Optional video id to process from the queue', required: false },
          bvid: { type: 'string', description: 'Alias for videoId when the source is Bilibili', required: false },
          url: { type: 'string', description: 'Optional source URL used to select a queued video', required: false },
          sourceUrl: { type: 'string', description: 'Alias for url', required: false },
        },
        resultType: 'resource',
        resourceRef: 'resource.video_ingest_queue',
        nextCapabilities: ['video.ingest.capture-local', 'video.knowledge.search', 'video.knowledge.get'],
      },
      {
        capabilityId: 'video.ingest.process-full',
        pluginId: 'plugin.video-knowledge',
        summary: 'Run the full local video ingestion pipeline and verify completion with check-video semantics before reporting success.',
        category: 'command',
        sideEffectLevel: 'reversible',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          videoId: { type: 'string', description: 'Optional video id to process from the queue', required: false },
          bvid: { type: 'string', description: 'Alias for videoId when the source is Bilibili', required: false },
          url: { type: 'string', description: 'Optional source URL used to select a queued video', required: false },
          sourceUrl: { type: 'string', description: 'Alias for url', required: false },
          download: { type: 'string', description: 'Whether to download missing media. Defaults to true.', required: false },
          probe: { type: 'string', description: 'Whether to run ffprobe when probe.json is missing. Defaults to true.', required: false },
          keyframes: { type: 'string', description: 'Whether to extract screenshots when none exist. Defaults to true.', required: false },
          frameIntervalSeconds: { type: 'string', description: 'Seconds between simple sampled screenshots. Defaults to 30.', required: false },
          maxFrames: { type: 'string', description: 'Maximum screenshots to extract. Defaults to 48.', required: false },
          provider: { type: 'string', description: 'Transcription provider: gemini, kimi, api, or whisper. Defaults to configured transcriptionProvider, then Gemini/API script inference, then gemini.', required: false },
          asrProvider: { type: 'string', description: 'Alias for provider; useful when the caller says ASR provider.', required: false },
          transcriptionProvider: { type: 'string', description: 'Alias for provider.', required: false },
          transcriptProvider: { type: 'string', description: 'Alias for provider.', required: false },
          asr: { type: 'string', description: 'Alias for provider when set to gemini/kimi/api/whisper.', required: false },
          whisper: { type: 'string', description: 'Only used when provider=whisper. Whether to run Whisper when transcript files are missing. Defaults to true.', required: false },
          transcriptionScriptPath: { type: 'string', description: 'Optional API transcription script path for gemini/kimi/api providers.', required: false },
          scriptPath: { type: 'string', description: 'Visual analysis script path; also accepted by transcription providers when relevant.', required: false },
          pythonPath: { type: 'string', description: 'Python executable path for API scripts and automatic keyframe selection.', required: false },
          mode: { type: 'string', description: 'Visual analysis mode: keyframes or clips. Defaults to keyframes.', required: false },
          model: { type: 'string', description: 'Vision/transcription model name.', required: false },
          endpoint: { type: 'string', description: 'Provider endpoint.', required: false },
          language: { type: 'string', description: 'Optional transcription language hint, such as zh or en.', required: false },
          visualSummaryPath: { type: 'string', description: 'Optional visual summary JSON path to compose', required: false },
          transcriptTextPath: { type: 'string', description: 'Optional ASR transcript text path', required: false },
          autoKeyframeSelection: { type: 'string', description: 'Whether to auto-generate semantic report keyframes. Defaults to true.', required: false },
          keyframePreset: { type: 'string', description: 'Automatic keyframe preset: semantic-tight/tight or balanced.', required: false },
          force: { type: 'string', description: 'When true, rerun reusable stages such as ASR to replace stale or invalid artifacts.', required: false },
          forceKeyframeSelection: { type: 'string', description: 'Rerun automatic keyframe selection even if cached.', required: false },
        },
        resultType: 'resource',
        resourceRef: 'resource.video_ingest_full_pipeline',
        nextCapabilities: ['video.knowledge.check', 'video.knowledge.get'],
      },
      {
        capabilityId: 'video.ingest.capture-local',
        pluginId: 'plugin.video-knowledge',
        summary: 'Download or reuse local video media, probe streams, and extract key screenshots for a prepared ingestion job.',
        category: 'command',
        sideEffectLevel: 'reversible',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          videoId: { type: 'string', description: 'Optional video id to capture from the prepared queue', required: false },
          bvid: { type: 'string', description: 'Alias for videoId when the source is Bilibili', required: false },
          url: { type: 'string', description: 'Optional source URL used to select a prepared video', required: false },
          sourceUrl: { type: 'string', description: 'Alias for url', required: false },
          videoPath: { type: 'string', description: 'Optional already downloaded local video path', required: false },
          download: { type: 'string', description: 'Whether to download missing media. Defaults to true.', required: false },
          probe: { type: 'string', description: 'Whether to run ffprobe when probe.json is missing. Defaults to true.', required: false },
          keyframes: { type: 'string', description: 'Whether to extract screenshots when none exist. Defaults to true.', required: false },
          frameIntervalSeconds: { type: 'string', description: 'Seconds between simple sampled screenshots. Defaults to 30.', required: false },
          maxFrames: { type: 'string', description: 'Maximum screenshots to extract. Defaults to 48.', required: false },
        },
        resultType: 'resource',
        resourceRef: 'resource.video_ingest_queue',
        nextCapabilities: ['video.ingest.transcribe-local', 'video.knowledge.search', 'video.knowledge.get'],
      },
      {
        capabilityId: 'video.ingest.transcribe-local',
        pluginId: 'plugin.video-knowledge',
        summary: 'Run local Whisper or API ASR, or index existing transcript files for a captured ingestion job.',
        category: 'command',
        sideEffectLevel: 'reversible',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          videoId: { type: 'string', description: 'Optional video id to transcribe from the captured queue', required: false },
          bvid: { type: 'string', description: 'Alias for videoId when the source is Bilibili', required: false },
          url: { type: 'string', description: 'Optional source URL used to select a captured video', required: false },
          sourceUrl: { type: 'string', description: 'Alias for url', required: false },
          videoPath: { type: 'string', description: 'Optional already downloaded local video path', required: false },
          provider: { type: 'string', description: 'Transcription provider: gemini, kimi, api, or whisper. Defaults to configured transcriptionProvider, then Gemini/API script inference, then gemini.', required: false },
          asrProvider: { type: 'string', description: 'Alias for provider; useful when the caller says ASR provider.', required: false },
          transcriptionProvider: { type: 'string', description: 'Alias for provider.', required: false },
          transcriptProvider: { type: 'string', description: 'Alias for provider.', required: false },
          asr: { type: 'string', description: 'Alias for provider when set to gemini/kimi/api/whisper.', required: false },
          whisper: { type: 'string', description: 'Only used when provider=whisper. Whether to run Whisper when transcript files are missing. Defaults to true.', required: false },
          transcriptionScriptPath: { type: 'string', description: 'Optional API transcription script path for gemini/kimi/api providers.', required: false },
          scriptPath: { type: 'string', description: 'Alias for transcriptionScriptPath.', required: false },
          pythonPath: { type: 'string', description: 'Python executable path for API transcription scripts.', required: false },
          model: { type: 'string', description: 'Whisper or API transcription model name.', required: false },
          endpoint: { type: 'string', description: 'Optional API endpoint, such as vertex-express, vertex-standard, or developer.', required: false },
          project: { type: 'string', description: 'Optional Google Cloud project for Vertex standard mode.', required: false },
          location: { type: 'string', description: 'Optional Google Cloud location.', required: false },
          language: { type: 'string', description: 'Optional transcription language hint, such as zh or en.', required: false },
          chunkSeconds: { type: 'string', description: 'Seconds per API audio chunk.', required: false },
          maxChunks: { type: 'string', description: 'Optional cap for API transcription smoke tests.', required: false },
          apiKeyEnv: { type: 'string', description: 'Environment variable name containing the API key for API transcription.', required: false },
          apiKeyFilePath: { type: 'string', description: 'Local file path containing the API key for API transcription.', required: false },
          apiKeyFile: { type: 'string', description: 'Alias for apiKeyFilePath.', required: false },
          task: { type: 'string', description: 'Optional Whisper task, such as transcribe or translate.', required: false },
          force: { type: 'string', description: 'Rerun transcription even if transcript files already exist. Defaults to false.', required: false },
          dryRun: { type: 'string', description: 'Write an API transcription plan without calling the model.', required: false },
        },
        resultType: 'resource',
        resourceRef: 'resource.video_ingest_queue',
        nextCapabilities: ['video.ingest.analyze-visual', 'video.knowledge.search', 'video.knowledge.get'],
      },
      {
        capabilityId: 'video.ingest.analyze-visual',
        pluginId: 'plugin.video-knowledge',
        summary: 'Run a configured visual analysis script over keyframes or clips for a captured ingestion job.',
        category: 'command',
        sideEffectLevel: 'reversible',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          videoId: { type: 'string', description: 'Optional video id to analyze from the captured queue', required: false },
          bvid: { type: 'string', description: 'Alias for videoId when the source is Bilibili', required: false },
          url: { type: 'string', description: 'Optional source URL used to select a captured video', required: false },
          sourceUrl: { type: 'string', description: 'Alias for url', required: false },
          videoPath: { type: 'string', description: 'Optional already downloaded local video path', required: false },
          scriptPath: { type: 'string', description: 'Path to the local visual analysis Python script', required: false },
          pythonPath: { type: 'string', description: 'Python executable path. Defaults to python unless configured.', required: false },
          mode: { type: 'string', description: 'Visual analysis mode: keyframes or clips. Defaults to keyframes.', required: false },
          model: { type: 'string', description: 'Vision model name, such as gemini-3.1-pro-preview.', required: false },
          endpoint: { type: 'string', description: 'Provider endpoint: vertex-standard, vertex-express, or developer.', required: false },
          project: { type: 'string', description: 'Optional Google Cloud project for Vertex standard mode.', required: false },
          location: { type: 'string', description: 'Optional Google Cloud location. Defaults inside the script.', required: false },
          segmentSeconds: { type: 'string', description: 'Seconds per visual segment.', required: false },
          chunkSeconds: { type: 'string', description: 'Alias for segmentSeconds.', required: false },
          frameInterval: { type: 'string', description: 'Seconds between extracted keyframes in keyframes mode.', required: false },
          maxSegments: { type: 'string', description: 'Optional cap for test or partial runs.', required: false },
          sleepSeconds: { type: 'string', description: 'Delay between provider calls.', required: false },
          apiKeyEnv: { type: 'string', description: 'Environment variable name containing the API key for visual analysis.', required: false },
          apiKeyFilePath: { type: 'string', description: 'Local file path containing the API key for visual analysis.', required: false },
          apiKeyFile: { type: 'string', description: 'Alias for apiKeyFilePath.', required: false },
          force: { type: 'string', description: 'Rerun even when the visual summary already exists. Defaults to false.', required: false },
          dryRun: { type: 'string', description: 'Validate paths and write a plan without calling the vision model.', required: false },
        },
        resultType: 'resource',
        resourceRef: 'resource.video_ingest_queue',
        nextCapabilities: ['video.ingest.compose-bundle', 'video.knowledge.search', 'video.knowledge.get'],
      },
      {
        capabilityId: 'video.ingest.compose-bundle',
        pluginId: 'plugin.video-knowledge',
        summary: 'Compose transcript and visual analysis summaries into searchable video knowledge evidence bundles.',
        category: 'command',
        sideEffectLevel: 'reversible',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          videoId: { type: 'string', description: 'Optional video id to compose from the visual-analysis queue', required: false },
          bvid: { type: 'string', description: 'Alias for videoId when the source is Bilibili', required: false },
          url: { type: 'string', description: 'Optional source URL used to select a visual analyzed video', required: false },
          sourceUrl: { type: 'string', description: 'Alias for url', required: false },
          visualSummaryPath: { type: 'string', description: 'Optional visual summary JSON path to compose', required: false },
          summaryPath: { type: 'string', description: 'Alias for visualSummaryPath', required: false },
          transcriptTextPath: { type: 'string', description: 'Optional ASR transcript text path', required: false },
        },
        resultType: 'resource',
        resourceRef: 'resource.video_ingest_queue',
        nextCapabilities: ['video.ingest.compose-document', 'video.knowledge.search', 'video.knowledge.get'],
      },
      {
        capabilityId: 'video.ingest.compose-document',
        pluginId: 'plugin.video-knowledge',
        summary: 'Compose a human-facing video report plus timestamped evidence document with screenshot assets.',
        category: 'command',
        sideEffectLevel: 'reversible',
        exposure: 'auto',
        connectorId: 'runtime.video-knowledge.main',
        inputSchema: {
          videoId: { type: 'string', description: 'Optional video id to document from the composed queue', required: false },
          bvid: { type: 'string', description: 'Alias for videoId when the source is Bilibili', required: false },
          url: { type: 'string', description: 'Optional source URL used to select a composed video', required: false },
          sourceUrl: { type: 'string', description: 'Alias for url', required: false },
          videoPath: { type: 'string', description: 'Optional local video path used to regenerate high-resolution document screenshots.', required: false },
          bundlePath: { type: 'string', description: 'Optional composed evidence bundle JSON path', required: false },
          transcriptTextPath: { type: 'string', description: 'Optional ASR transcript text path', required: false },
          documentPath: { type: 'string', description: 'Optional human-facing Markdown report output path. Defaults to video-report.md.', required: false },
          reportPath: { type: 'string', description: 'Alias for documentPath / human-facing report path.', required: false },
          evidencePath: { type: 'string', description: 'Optional timestamped evidence Markdown output path. Defaults to video-evidence.md.', required: false },
          documentManifestPath: { type: 'string', description: 'Optional document manifest output path.', required: false },
          documentAssetsDir: { type: 'string', description: 'Optional directory for regenerated or copied document screenshots.', required: false },
          assetsDir: { type: 'string', description: 'Alias for documentAssetsDir', required: false },
          documentVariant: { type: 'string', description: 'Optional experimental document variant suffix, such as hybrid-keyframes. Variant outputs do not replace canonical video-report.md files.', required: false },
          variant: { type: 'string', description: 'Alias for documentVariant.', required: false },
          experimental: { type: 'string', description: 'When true, write an experimental report variant without updating canonical processed-video paths.', required: false },
          keyframeManifestPath: { type: 'string', description: 'Optional select_keyframes.py manifest whose selected frames should be used as report screenshots.', required: false },
          screenshotManifestPath: { type: 'string', description: 'Alias for keyframeManifestPath.', required: false },
          keyframeSelectionManifestPath: { type: 'string', description: 'Alias for keyframeManifestPath.', required: false },
          autoKeyframeSelection: { type: 'string', description: 'Whether to auto-generate semantic report keyframes when no manifest is provided. Defaults to true.', required: false },
          keyframePreset: { type: 'string', description: 'Automatic keyframe preset: semantic-tight/tight or balanced. Defaults to semantic-tight.', required: false },
          reportKeyframePreset: { type: 'string', description: 'Alias for keyframePreset.', required: false },
          visualSummaryPath: { type: 'string', description: 'Optional Gemini/OCR visual summary used for automatic semantic keyframe selection.', required: false },
          semanticManifestPath: { type: 'string', description: 'Alias for visualSummaryPath when using automatic semantic keyframe selection.', required: false },
          keyframeSelectorScriptPath: { type: 'string', description: 'Optional path to select_keyframes.py or compatible selector script.', required: false },
          selectorScriptPath: { type: 'string', description: 'Alias for keyframeSelectorScriptPath.', required: false },
          pythonPath: { type: 'string', description: 'Python executable used for automatic keyframe selection.', required: false },
          semanticMinScore: { type: 'string', description: 'Minimum semantic score for automatic selector. Tight default is 0.80.', required: false },
          semanticWindowSeconds: { type: 'string', description: 'Semantic timestamp matching window in seconds. Tight default is 10.', required: false },
          maxFramesPerMinute: { type: 'string', description: 'Maximum selected frames per minute. Tight default is 3.', required: false },
          targetIntervalSeconds: { type: 'string', description: 'Timeline coverage interval for automatic keyframe selection. Defaults to 30.', required: false },
          diffThreshold: { type: 'string', description: 'Visual clustering diff threshold for automatic keyframe selection. Defaults to 0.08.', required: false },
          intervalSeconds: { type: 'string', description: 'Sampling interval for automatic keyframe selection. Defaults to 2.', required: false },
          forceKeyframeSelection: { type: 'string', description: 'Regenerate automatic keyframe manifest even when it already exists.', required: false },
        },
        resultType: 'resource',
        resourceRef: 'resource.video_ingest_queue',
        nextCapabilities: [],
      },
    ],
  },
  handlers: {
    'video.knowledge.search': async (input, context) => {
      const query = normalizeInput(input.query);
      const videoId = normalizeInput(input.videoId);

      if (!query) {
        throw new AppError('validation_failed', 'Search query is required.', {
          details: { query: input.query },
        });
      }

      const videos = loadVideos(context.connector as VideoKnowledgeConnector)
        .filter(isProcessedVideo)
        .filter((video) => !videoId || video.videoId === videoId);
      const items = videos
        .map((video) => ({ video, matches: toSearchMatches(video, query) }))
        .filter((entry) => entry.matches.length > 0 || includesQuery(entry.video, query))
        .sort((a, b) => {
          // Relevance first: explicit field matches beat title-only
          // substring hits. matches.length is the count of fielded matches
          // (operation_note / timeline / transcript / visible_text / gotcha
          // / formula). A video with matches=0 only made it through via the
          // loose includesQuery title fallback and should rank below any
          // video with a real fielded hit.
          if (b.matches.length !== a.matches.length) {
            return b.matches.length - a.matches.length;
          }
          // Tiebreaker: video_value.score (higher is better). Falls back to
          // 0 when the bundle predates the scoring step.
          const scoreA = typeof a.video.videoValue?.score === 'number' ? (a.video.videoValue.score as number) : 0;
          const scoreB = typeof b.video.videoValue?.score === 'number' ? (b.video.videoValue.score as number) : 0;
          return scoreB - scoreA;
        })
        .map((entry) => toSearchResult(entry.video, entry.matches));

      return {
        resultType: 'resource_list',
        resourceRef: 'resource.video_knowledge',
        finality: 'final',
        data: { items },
        nextCapabilities: ['video.knowledge.get'],
      };
    },
    'video.knowledge.get': async (input, context) => {
      const videoId = normalizeInput(input.videoId);

      if (!videoId) {
        throw new AppError('validation_failed', 'Video id is required.', {
          details: { videoId: input.videoId },
        });
      }

      const video = findVideoById(loadVideos(context.connector as VideoKnowledgeConnector), videoId);

      if (!video || !isProcessedVideo(video)) {
        throw new AppError('resource_not_found', `Video knowledge bundle ${videoId} was not found.`, {
          details: video ? { videoId, status: 'in_progress', stage: getPartialVideoStage(video) } : { videoId },
          statusCode: 404,
        });
      }

      return {
        resultType: 'resource',
        resourceRef: 'resource.video_knowledge',
        finality: 'final',
        data: { video },
        nextCapabilities: [],
      };
    },
    'video.knowledge.check': async (input, context) => {
      const videoId = normalizeInput(input.videoId);

      if (!videoId) {
        throw new AppError('validation_failed', 'Video id is required.', {
          details: { videoId: input.videoId },
        });
      }

      const data = toVideoKnowledgeStatus(videoId, context.connector as VideoKnowledgeConnector);

      return {
        resultType: 'resource',
        resourceRef: 'resource.video_knowledge_status',
        finality: 'final',
        data,
        nextCapabilities: data.status === 'processed'
          ? ['video.knowledge.get']
          : data.status === 'processed_invalid_transcript'
            ? ['video.ingest.transcribe-local']
            : ['video.ingest.enqueue'],
      };
    },
    'video.environment.check': async (input, context) => ({
      resultType: 'resource',
      resourceRef: 'resource.video_environment',
      finality: 'final',
      data: checkVideoKnowledgeEnvironment(input, context.connector as VideoKnowledgeConnector),
      nextCapabilities: ['video.ingest.process-full'],
    }),
    'bilibili.favorites.sync': async (input, context) => {
      const data = await syncBilibiliFavorites(input, context);

      return {
        resultType: 'resource',
        resourceRef: 'resource.bilibili_favorites',
        finality: 'final',
        data,
        nextCapabilities: ['bilibili.favorites.list', 'bilibili.favorites.orphans', 'video.knowledge.search'],
      };
    },
    'bilibili.favorites.folders': async (input, context) => {
      const data = await listCurrentBilibiliFavoriteFolders(input, context);

      return {
        resultType: 'resource_list',
        resourceRef: 'resource.bilibili_favorite_folders',
        finality: 'final',
        data,
        nextCapabilities: ['bilibili.favorites.sync', 'bilibili.favorites.list', 'bilibili.favorites.orphans'],
      };
    },
    'bilibili.favorites.list': async (input, context) => ({
      resultType: 'resource_list',
      resourceRef: 'resource.bilibili_favorites',
      finality: 'final',
      data: listBilibiliFavorites(input, context),
      nextCapabilities: ['bilibili.favorites.search', 'bilibili.favorites.orphans', 'video.knowledge.search'],
    }),
    'bilibili.favorites.search': async (input, context) => ({
      resultType: 'resource_list',
      resourceRef: 'resource.bilibili_favorites',
      finality: 'final',
      data: searchBilibiliFavorites(input, context),
      nextCapabilities: ['video.knowledge.search', 'video.knowledge.get'],
    }),
    'bilibili.favorites.orphans': async (input, context) => ({
      resultType: 'resource_list',
      resourceRef: 'resource.bilibili_favorite_orphans',
      finality: 'final',
      data: listBilibiliFavoriteOrphans(input, context),
      nextCapabilities: ['video.knowledge.check', 'video.knowledge.get'],
    }),
    'video.ingest.enqueue': async (input, context) => ({
      resultType: 'resource',
      resourceRef: 'resource.video_ingest_queue',
      finality: 'final',
      data: enqueueVideoIngestion(input, context),
      nextCapabilities: ['video.ingest.process-next', 'bilibili.favorites.search', 'video.knowledge.search'],
    }),
    'video.ingest.process-next': async (input, context) => ({
      resultType: 'resource',
      resourceRef: 'resource.video_ingest_queue',
      finality: 'final',
      data: processNextVideoIngestion(input, context),
      nextCapabilities: ['video.ingest.capture-local', 'video.knowledge.search', 'video.knowledge.get'],
    }),
    'video.ingest.process-full': async (input, context) => {
      const data = processFullVideoIngestion(input, context);

      return {
        resultType: 'resource',
        resourceRef: 'resource.video_ingest_full_pipeline',
        finality: 'final',
        data,
        nextCapabilities: data.outcome === 'processed'
          ? ['video.knowledge.check', 'video.knowledge.get']
          : ['video.ingest.process-full', 'video.knowledge.check'],
      };
    },
    'video.ingest.capture-local': async (input, context) => ({
      resultType: 'resource',
      resourceRef: 'resource.video_ingest_queue',
      finality: 'final',
      data: captureLocalVideoEvidence(input, context),
      nextCapabilities: ['video.ingest.transcribe-local', 'video.knowledge.search', 'video.knowledge.get'],
    }),
    'video.ingest.transcribe-local': async (input, context) => ({
      resultType: 'resource',
      resourceRef: 'resource.video_ingest_queue',
      finality: 'final',
      data: transcribeLocalVideoEvidence(input, context),
      nextCapabilities: ['video.ingest.analyze-visual', 'video.knowledge.search', 'video.knowledge.get'],
    }),
    'video.ingest.analyze-visual': async (input, context) => ({
      resultType: 'resource',
      resourceRef: 'resource.video_ingest_queue',
      finality: 'final',
      data: analyzeVisualVideoEvidence(input, context),
      nextCapabilities: ['video.ingest.compose-bundle', 'video.knowledge.search', 'video.knowledge.get'],
    }),
    'video.ingest.compose-bundle': async (input, context) => ({
      resultType: 'resource',
      resourceRef: 'resource.video_ingest_queue',
      finality: 'final',
      data: composeVideoEvidenceBundle(input, context),
      nextCapabilities: ['video.ingest.compose-document', 'video.knowledge.search', 'video.knowledge.get'],
    }),
    'video.ingest.compose-document': async (input, context) => ({
      resultType: 'resource',
      resourceRef: 'resource.video_ingest_queue',
      finality: 'final',
      data: composeVideoEvidenceDocument(input, context),
      nextCapabilities: [],
    }),
  },
};

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { PluginHandlerContext } from '../../contracts/index.js';
import { AppError } from '../../executor/app-error.js';
import {
  asObject,
  asObjectArray,
  extractBilibiliVideoId,
  firstString,
  normalizeInput,
  parseBoolean,
  parseLimit,
  readJsonObject,
  readTextFile,
  transcriptInvalidReason,
  valueToNumber,
  writeJsonFileAtomic,
} from './common.js';
import {
  assertVideoKnowledgeEnvironmentRequirements,
  buildCaptureEnvironmentRequirements,
  buildDocumentEnvironmentRequirements,
  buildTranscriptionEnvironmentRequirements,
  buildVisualEnvironmentRequirements,
  checkVideoKnowledgeEnvironmentRequirements,
  type VideoKnowledgeEnvironmentRequirement,
} from './environment.js';
import { getBilibiliFavoritesIndexPaths, getBilibiliFavoritesVideos } from './favorites-index.js';
import { getBilibiliCookie, getQueuesRootPath, getVideoRootPath, resolveConfiguredPath } from './paths.js';
import type { VideoKnowledgeConnector } from './types.js';

export function getVideoIngestQueuePath(connector: VideoKnowledgeConnector): string {
  return join(getQueuesRootPath(connector), 'video-ingest.json');
}

function loadVideoIngestQueue(queuePath: string): Record<string, unknown> {
  return readJsonObject(queuePath) ?? {
    version: 1,
    jobs: [],
  };
}

function findBilibiliFavoriteVideo(connector: VideoKnowledgeConnector, videoId: string): Record<string, unknown> | undefined {
  const { officialIndexPath } = getBilibiliFavoritesIndexPaths(connector);
  const index = readJsonObject(officialIndexPath);

  if (!index) {
    return undefined;
  }

  return getBilibiliFavoritesVideos(index).find((video) => video.bvid === videoId || video.knowledgeVideoId === videoId);
}

function normalizeIngestPriority(value: unknown): string {
  const priority = normalizeInput(value).toLowerCase();

  return priority || 'normal';
}

function buildVideoIngestJob(
  input: Record<string, unknown>,
  context: PluginHandlerContext,
): Record<string, unknown> {
  const connector = context.connector as VideoKnowledgeConnector;
  const videoId = normalizeInput(input.videoId ?? input.bvid) || extractBilibiliVideoId(input.url ?? input.sourceUrl);

  if (!videoId) {
    throw new AppError('validation_failed', 'A videoId, bvid, or Bilibili URL is required to enqueue video ingestion.', {
      details: {
        acceptedInputs: ['videoId', 'bvid', 'url', 'sourceUrl'],
      },
    });
  }

  const sourceUrl = firstString(input.sourceUrl, input.url) ?? `https://www.bilibili.com/video/${videoId}/`;
  const favoriteVideo = findBilibiliFavoriteVideo(connector, videoId);
  const platform = firstString(input.platform, favoriteVideo?.platform) ?? 'bilibili';
  const sourceMetadata = favoriteVideo
    ? {
        folderId: favoriteVideo.folderId,
        folderTitle: favoriteVideo.folderTitle,
        author: favoriteVideo.author,
        authorId: favoriteVideo.authorId,
        duration: favoriteVideo.duration,
        collectedAt: favoriteVideo.collectedAt,
        publishedAt: favoriteVideo.publishedAt,
        cover: favoriteVideo.cover,
        intro: favoriteVideo.intro,
      }
    : {};

  return {
    jobId: `${platform}:${videoId}`,
    status: 'queued',
    platform,
    videoId,
    sourceUrl,
    title: firstString(input.title, favoriteVideo?.title) ?? videoId,
    priority: normalizeIngestPriority(input.priority),
    reason: firstString(input.reason, input.note),
    queuedAt: context.now(),
    updatedAt: context.now(),
    sourceMetadata,
    metadataOnly: true,
    contentEvidence: false,
  };
}

function getQueueStats(jobs: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    queued: jobs.filter((job) => job.status === 'queued').length,
    prepared: jobs.filter((job) => job.status === 'prepared').length,
    captured: jobs.filter((job) => job.status === 'captured').length,
    transcribed: jobs.filter((job) => job.status === 'transcribed').length,
    visualAnalyzed: jobs.filter((job) => job.status === 'visual_analyzed').length,
    done: jobs.filter((job) => job.status === 'done').length,
    failed: jobs.filter((job) => job.status === 'failed').length,
    total: jobs.length,
  };
}

export function enqueueVideoIngestion(
  input: Record<string, unknown>,
  context: PluginHandlerContext,
): Record<string, unknown> {
  const connector = context.connector as VideoKnowledgeConnector;
  const queuePath = getVideoIngestQueuePath(connector);
  const queue = loadVideoIngestQueue(queuePath);
  const jobs = asObjectArray(queue.jobs);
  const candidate = buildVideoIngestJob(input, context);
  const existing = jobs.find((job) => job.jobId === candidate.jobId || job.videoId === candidate.videoId);
  const job = existing ?? candidate;

  if (!existing) {
    jobs.push(candidate);
  }

  const outputQueue = {
    ...queue,
    version: valueToNumber(queue.version) ?? 1,
    updatedAt: context.now(),
    jobs,
  };

  writeJsonFileAtomic(queuePath, outputQueue);

  return {
    queuePath,
    enqueued: !existing,
    deduped: Boolean(existing),
    metadataOnly: true,
    contentEvidence: false,
    job,
    processingState: {
      status: job.status,
      started: false,
      guidance: 'This request only added or found a queued job. Do not say it is processing in the background unless a later process/capture/transcribe/analyze capability has been run.',
    },
    stats: getQueueStats(jobs),
  };
}

function getPriorityScore(priority: unknown): number {
  switch (normalizeInput(priority).toLowerCase()) {
    case 'urgent':
      return 3;
    case 'high':
      return 2;
    case 'low':
      return 0;
    default:
      return 1;
  }
}

function getVideoIdFromJob(job: Record<string, unknown>): string | undefined {
  return firstString(job.videoId, job.bvid) ?? extractBilibiliVideoId(job.sourceUrl ?? job.url);
}

function getTargetVideoId(input: Record<string, unknown>): string | undefined {
  return firstString(input.videoId, input.bvid) ?? extractBilibiliVideoId(input.url ?? input.sourceUrl);
}

function toSafePathSegment(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, '_') || 'unknown-video';
}

function selectNextQueuedJob(
  jobs: Array<Record<string, unknown>>,
  targetVideoId: string | undefined,
): { job: Record<string, unknown>; index: number } | undefined {
  let selected: { job: Record<string, unknown>; index: number; score: number } | undefined;

  jobs.forEach((job, index) => {
    if (job.status !== 'queued') {
      return;
    }

    const videoId = getVideoIdFromJob(job);

    if (targetVideoId && videoId !== targetVideoId) {
      return;
    }

    const score = getPriorityScore(job.priority);

    if (!selected || score > selected.score) {
      selected = { job, index, score };
    }
  });

  return selected ? { job: selected.job, index: selected.index } : undefined;
}

function selectLocalCaptureJob(
  jobs: Array<Record<string, unknown>>,
  targetVideoId: string | undefined,
): { job: Record<string, unknown>; index: number } | undefined {
  return jobs
    .map((job, index) => ({ job, index }))
    .find(({ job }) => {
      if (!['prepared', 'captured', 'transcribed', 'visual_analyzed', 'done'].includes(normalizeInput(job.status))) {
        return false;
      }

      const videoId = getVideoIdFromJob(job);
      return !targetVideoId || videoId === targetVideoId;
    });
}

function getStatusAfterCapture(existingStatus: unknown, mediaEvidence: boolean): string {
  const status = normalizeInput(existingStatus);

  if (mediaEvidence && ['transcribed', 'visual_analyzed', 'done'].includes(status)) {
    return status;
  }

  return mediaEvidence ? 'captured' : 'prepared';
}

function selectLocalTranscriptionJob(
  jobs: Array<Record<string, unknown>>,
  targetVideoId: string | undefined,
): { job: Record<string, unknown>; index: number } | undefined {
  return jobs
    .map((job, index) => ({ job, index }))
    .find(({ job }) => {
      if (!['captured', 'transcribed', 'visual_analyzed', 'done'].includes(normalizeInput(job.status))) {
        return false;
      }

      const videoId = getVideoIdFromJob(job);
      return !targetVideoId || videoId === targetVideoId;
    });
}

function getStatusAfterTranscription(existingStatus: unknown, transcriptEvidence: boolean): string {
  const status = normalizeInput(existingStatus);
  if (['done', 'visual_analyzed'].includes(status)) {
    return status;
  }

  return transcriptEvidence ? 'transcribed' : 'captured';
}

function getStatusAfterVisualAnalysis(
  existingStatus: unknown,
  visualEvidence: boolean,
  transcriptEvidence: boolean,
  mediaEvidence: boolean,
  contentEvidence: boolean,
): string {
  if (contentEvidence) {
    return 'done';
  }

  if (visualEvidence) {
    return 'visual_analyzed';
  }

  if (transcriptEvidence) {
    return 'transcribed';
  }

  if (mediaEvidence) {
    return 'captured';
  }

  return normalizeInput(existingStatus) || 'prepared';
}

function withoutOutOfBoundaryFields(record: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...record };
  delete cleaned[['wiki', 'Candidates', 'Path'].join('')];
  return cleaned;
}

function selectLocalVisualAnalysisJob(
  jobs: Array<Record<string, unknown>>,
  targetVideoId: string | undefined,
): { job: Record<string, unknown>; index: number } | undefined {
  return jobs
    .map((job, index) => ({ job, index }))
    .find(({ job }) => {
      if (!['captured', 'transcribed', 'visual_analyzed', 'done'].includes(normalizeInput(job.status))) {
        return false;
      }

      const videoId = getVideoIdFromJob(job);
      return !targetVideoId || videoId === targetVideoId;
    });
}

function selectBundleCompositionJob(
  jobs: Array<Record<string, unknown>>,
  targetVideoId: string | undefined,
): { job: Record<string, unknown>; index: number } | undefined {
  return jobs
    .map((job, index) => ({ job, index }))
    .find(({ job }) => {
      if (!['visual_analyzed', 'done'].includes(normalizeInput(job.status))) {
        return false;
      }

      const videoId = getVideoIdFromJob(job);
      return !targetVideoId || videoId === targetVideoId;
    });
}

function hasProcessedEvidence(workDir: string): boolean {
  return [
    'qwen-style-video-analysis-bundle.json',
    'hard-subtitle-operation-notes.safe.json',
    'video-report-insights.json',
  ].some((fileName) => existsSync(join(workDir, fileName)));
}

function buildSourceInfo(
  job: Record<string, unknown>,
  options: {
    status: 'prepared' | 'done';
    now: string;
    queuePath: string;
    workDir: string;
    sourceInfoPath: string;
    contentEvidence: boolean;
  },
): Record<string, unknown> {
  const existingSourceInfo = readJsonObject(options.sourceInfoPath) ?? {};
  const videoId = getVideoIdFromJob(job);
  const sourceMetadata = asObject(job.sourceMetadata) ?? {};
  const sourceUrl = firstString(job.sourceUrl, job.url) ?? (videoId ? `https://www.bilibili.com/video/${videoId}/` : undefined);

  return {
    ...existingSourceInfo,
    id: firstString(existingSourceInfo.id, videoId),
    video_id: firstString(existingSourceInfo.video_id, videoId),
    source_url: firstString(existingSourceInfo.source_url, sourceUrl),
    webpage_url: firstString(existingSourceInfo.webpage_url, sourceUrl),
    platform_title: firstString(existingSourceInfo.platform_title, job.title, videoId),
    platform: firstString(existingSourceInfo.platform, job.platform) ?? 'bilibili',
    source_metadata: sourceMetadata,
    ingest: {
      ...(asObject(existingSourceInfo.ingest) ?? {}),
      status: options.status,
      jobId: firstString(job.jobId),
      priority: firstString(job.priority),
      reason: firstString(job.reason),
      queuedAt: firstString(job.queuedAt),
      preparedAt: options.now,
      queuePath: options.queuePath,
      workDir: options.workDir,
      sourceInfoPath: options.sourceInfoPath,
      metadataOnly: !options.contentEvidence,
      contentEvidence: options.contentEvidence,
    },
  };
}

export function processNextVideoIngestion(
  input: Record<string, unknown>,
  context: PluginHandlerContext,
): Record<string, unknown> {
  const connector = context.connector as VideoKnowledgeConnector;
  const queuePath = getVideoIngestQueuePath(connector);
  const queue = loadVideoIngestQueue(queuePath);
  const jobs = asObjectArray(queue.jobs);
  const selected = selectNextQueuedJob(jobs, getTargetVideoId(input));

  if (!selected) {
    return {
      queuePath,
      outcome: 'empty_queue',
      selected: false,
      metadataOnly: true,
      contentEvidence: false,
      stats: getQueueStats(jobs),
    };
  }

  const now = context.now();
  const job = selected.job;
  const videoId = getVideoIdFromJob(job);

  if (!videoId) {
    throw new AppError('validation_failed', 'Queued video ingestion job is missing a usable video id.', {
      details: {
        job,
      },
    });
  }

  const workDir = join(getVideoRootPath(connector), toSafePathSegment(videoId));
  const sourceInfoPath = join(workDir, 'source.info.json');
  const contentEvidence = hasProcessedEvidence(workDir);
  const status = contentEvidence ? 'done' : 'prepared';
  const sourceInfo = buildSourceInfo(job, {
    status,
    now,
    queuePath,
    workDir,
    sourceInfoPath,
    contentEvidence,
  });

  writeJsonFileAtomic(sourceInfoPath, sourceInfo);

  const updatedJob = {
    ...withoutOutOfBoundaryFields(job),
    status,
    updatedAt: now,
    preparedAt: now,
    workDir,
    sourceInfoPath,
    metadataOnly: !contentEvidence,
    contentEvidence,
    ...(contentEvidence ? { doneAt: now } : {}),
  };
  jobs[selected.index] = updatedJob;

  const outputQueue = {
    ...queue,
    version: valueToNumber(queue.version) ?? 1,
    updatedAt: now,
    jobs,
  };

  writeJsonFileAtomic(queuePath, outputQueue);

  return {
    queuePath,
    outcome: contentEvidence ? 'already_done' : 'prepared',
    selected: true,
    workDir,
    sourceInfoPath,
    metadataOnly: !contentEvidence,
    contentEvidence,
    job: updatedJob,
    stats: getQueueStats(jobs),
    nextStep: contentEvidence
      ? 'Search or get the processed video evidence bundle.'
      : 'Run the video compiler pipeline for this work directory before answering content questions.',
  };
}

function getConfiguredBinary(connector: VideoKnowledgeConnector, key: string, fallback: string): string {
  return normalizeInput(connector.config?.[key]) || fallback;
}

function getDefaultPythonCommand(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function buildNetscapeCookieFile(cookieHeader: string): string {
  const lines = ['# Netscape HTTP Cookie File'];
  cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes('='))
    .forEach((part) => {
      const [rawName, ...rawValueParts] = part.split('=');
      const name = rawName.trim();
      const value = rawValueParts.join('=').trim();

      if (!name || !value || /[\r\n\t]/.test(name) || /[\r\n\t]/.test(value)) {
        return;
      }

      lines.push(['.bilibili.com', 'TRUE', '/', 'TRUE', '0', name, value].join('\t'));
    });

  return `${lines.join('\n')}\n`;
}

function writeBilibiliYtDlpCookieFile(workDir: string, cookieHeader: string): string {
  const cookiePath = join(workDir, 'bilibili.yt-dlp.cookies.txt');
  writeFileSync(cookiePath, buildNetscapeCookieFile(cookieHeader), 'utf8');
  return cookiePath;
}

function runLocalCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    step: string;
  },
): { command: string; args: string[]; skipped: false; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    throw new AppError('connector_unavailable', `Local video capture step ${options.step} failed.`, {
      details: {
        step: options.step,
        command,
        args,
        exitCode: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        cause: result.error instanceof Error ? result.error.message : undefined,
      },
    });
  }

  return {
    command,
    args,
    skipped: false,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function listScreenshots(screenshotDirectory: string): Array<Record<string, unknown>> {
  if (!existsSync(screenshotDirectory)) {
    return [];
  }

  return readdirSync(screenshotDirectory)
    .filter((fileName) => /\.(png|jpg|jpeg|webp)$/i.test(fileName))
    .sort()
    .map((fileName) => ({
      path: join(screenshotDirectory, fileName),
    }));
}

function findDownloadedVideo(workDir: string): string | undefined {
  const preferred = join(workDir, 'video.mp4');

  if (existsSync(preferred)) {
    return preferred;
  }

  if (!existsSync(workDir)) {
    return undefined;
  }

  const candidate = readdirSync(workDir)
    .filter((fileName) => /^video\.(mp4|mkv|webm|mov|m4v)$/i.test(fileName))
    .sort()[0];

  return candidate ? join(workDir, candidate) : undefined;
}

function findTranscriptArtifact(asrDir: string, extension: string): string | undefined {
  const preferred = join(asrDir, `transcript.${extension}`);

  if (existsSync(preferred)) {
    return preferred;
  }

  if (!existsSync(asrDir)) {
    return undefined;
  }

  const suffix = `.${extension.toLowerCase()}`;
  const candidate = readdirSync(asrDir)
    .filter((fileName) => {
      const lower = fileName.toLowerCase();
      return lower.endsWith(suffix)
        && !lower.includes('manifest')
        && !lower.includes('plan')
        && !lower.includes('.error.');
    })
    .sort()[0];

  return candidate ? join(asrDir, candidate) : undefined;
}

function copyToCanonicalTranscriptPath(sourcePath: string | undefined, targetPath: string): string | undefined {
  if (existsSync(targetPath)) {
    return targetPath;
  }

  if (!sourcePath || !existsSync(sourcePath)) {
    return undefined;
  }

  if (transcriptInvalidReason(readTextFile(sourcePath))) {
    return undefined;
  }

  copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function buildTranscriptLines(textPath: string | undefined): string[] {
  const transcript = textPath ? readTextFile(textPath) : undefined;

  if (!transcript) {
    return [];
  }

  if (transcriptInvalidReason(transcript)) {
    return [];
  }

  return transcript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildTranscriptPreview(textPath: string | undefined): string[] {
  return buildTranscriptLines(textPath).slice(0, 12);
}

function updateSourceInfoAfterLocalCapture(
  sourceInfoPath: string,
  options: {
    now: string;
    manifestPath: string;
    videoPath: string;
    probePath: string;
    screenshotDirectory: string;
    mediaEvidence: boolean;
  },
): void {
  const sourceInfo = readJsonObject(sourceInfoPath) ?? {};
  writeJsonFileAtomic(sourceInfoPath, {
    ...sourceInfo,
    ingest: {
      ...(asObject(sourceInfo.ingest) ?? {}),
      status: options.mediaEvidence ? 'captured' : 'prepared',
      localCaptureAt: options.now,
      localCaptureManifestPath: options.manifestPath,
      videoPath: options.videoPath,
      probePath: options.probePath,
      screenshotDirectory: options.screenshotDirectory,
      mediaEvidence: options.mediaEvidence,
      contentEvidence: false,
      metadataOnly: !options.mediaEvidence,
    },
  });
}

function updateSourceInfoAfterLocalTranscription(
  sourceInfoPath: string,
  options: {
    now: string;
    transcriptProvider: string;
    transcriptManifestPath: string;
    textPath: string | undefined;
    jsonPath: string | undefined;
    srtPath: string | undefined;
    transcriptEvidence: boolean;
  },
): void {
  const sourceInfo = readJsonObject(sourceInfoPath) ?? {};
  const existingIngest = withoutOutOfBoundaryFields(asObject(sourceInfo.ingest) ?? {});
  const mediaEvidence = existingIngest.mediaEvidence === true;
  const visualEvidence = existingIngest.visualEvidence === true;
  const contentEvidence = existingIngest.contentEvidence === true;

  writeJsonFileAtomic(sourceInfoPath, {
    ...sourceInfo,
    ingest: {
      ...existingIngest,
      status: getStatusAfterTranscription(existingIngest.status, options.transcriptEvidence),
      transcribedAt: options.transcriptEvidence ? options.now : undefined,
      transcriptionCheckedAt: options.now,
      transcriptProvider: options.transcriptProvider,
      transcriptManifestPath: options.transcriptManifestPath,
      transcriptTextPath: options.textPath,
      transcriptJsonPath: options.jsonPath,
      transcriptSrtPath: options.srtPath,
      transcriptEvidence: options.transcriptEvidence,
      contentEvidence,
      metadataOnly: !(mediaEvidence || visualEvidence || options.transcriptEvidence || contentEvidence),
    },
  });
}

function getVisualAnalysisMode(input: Record<string, unknown>): string {
  const mode = normalizeInput(input.mode).toLowerCase();

  if (['clips', 'hard-subtitles', 'hard_subtitles'].includes(mode)) {
    return 'clips';
  }

  return 'keyframes';
}

function getVisualAnalysisWorkDir(workDir: string, mode: string): string {
  return join(workDir, mode === 'clips' ? 'hard_subtitle_steps' : 'keyframe_steps');
}

function getVisualAnalysisSummaryPath(visualWorkDir: string, mode: string): string {
  return join(visualWorkDir, mode === 'clips' ? 'hard-subtitle-steps-summary.json' : 'keyframe-steps-summary.json');
}

function findVisualSummaryPath(workDir: string): string | undefined {
  return [
    join(workDir, 'keyframe_steps', 'keyframe-steps-summary.json'),
    join(workDir, 'hard_subtitle_steps', 'hard-subtitle-steps-summary.json'),
  ].find((candidate) => existsSync(candidate));
}

function getVisualAnalysisScriptPath(
  input: Record<string, unknown>,
  connector: VideoKnowledgeConnector,
): string | undefined {
  const configured = firstString(
    input.scriptPath,
    connector.config?.visualAnalysisScriptPath,
    process.env.VIDEO_KNOWLEDGE_VISUAL_ANALYSIS_SCRIPT,
  );

  return configured ? resolveConfiguredPath(configured) : undefined;
}

function getKeyframeSelectorScriptPath(
  input: Record<string, unknown>,
  connector: VideoKnowledgeConnector,
): string | undefined {
  const configured = firstString(
    input.keyframeSelectorScriptPath,
    input.selectorScriptPath,
    connector.config?.keyframeSelectorScriptPath,
    process.env.VIDEO_KNOWLEDGE_KEYFRAME_SELECTOR_SCRIPT,
  );

  if (configured) {
    return resolveConfiguredPath(configured);
  }

  const defaultPath = resolveConfiguredPath(join('skills', 'video-knowledge', 'scripts', 'select_keyframes.py'));
  return existsSync(defaultPath) ? defaultPath : undefined;
}

function getPythonPath(
  input: Record<string, unknown>,
  connector: VideoKnowledgeConnector,
): string {
  return firstString(
    input.pythonPath,
    input.keyframeSelectorPythonPath,
    connector.config?.pythonPath,
    connector.config?.keyframeSelectorPythonPath,
    process.env.VIDEO_KNOWLEDGE_PYTHON,
  ) ?? getDefaultPythonCommand();
}

function getTranscriptionScriptPath(
  input: Record<string, unknown>,
  connector: VideoKnowledgeConnector,
): string | undefined {
  const configured = firstString(
    input.transcriptionScriptPath,
    input.scriptPath,
    connector.config?.transcriptionScriptPath,
    process.env.VIDEO_KNOWLEDGE_TRANSCRIPTION_SCRIPT,
  );

  if (configured) {
    return resolveConfiguredPath(configured);
  }

  const defaultPath = resolveConfiguredPath(join('skills', 'video-knowledge', 'scripts', 'transcribe_audio_gemini.py'));
  return existsSync(defaultPath) ? defaultPath : undefined;
}

function getTranscriptionApiKeyFilePath(
  input: Record<string, unknown>,
  connector: VideoKnowledgeConnector,
): string | undefined {
  const configured = firstString(
    input.apiKeyFilePath,
    input.apiKeyFile,
    connector.config?.transcriptionApiKeyFilePath,
    connector.config?.visionApiKeyFilePath,
    connector.config?.geminiApiKeyFilePath,
    connector.config?.apiKeyFilePath,
    process.env.VIDEO_KNOWLEDGE_TRANSCRIPTION_API_KEY_FILE,
    process.env.VIDEO_KNOWLEDGE_VISION_API_KEY_FILE,
    process.env.VIDEO_KNOWLEDGE_GEMINI_API_KEY_FILE,
  );

  return configured ? resolveConfiguredPath(configured) : undefined;
}

function getVisualApiKeyFilePath(
  input: Record<string, unknown>,
  connector: VideoKnowledgeConnector,
): string | undefined {
  const configured = firstString(
    input.apiKeyFilePath,
    input.apiKeyFile,
    connector.config?.visionApiKeyFilePath,
    connector.config?.geminiApiKeyFilePath,
    connector.config?.apiKeyFilePath,
    process.env.VIDEO_KNOWLEDGE_VISION_API_KEY_FILE,
    process.env.VIDEO_KNOWLEDGE_GEMINI_API_KEY_FILE,
  );

  return configured ? resolveConfiguredPath(configured) : undefined;
}

function normalizeTranscriptProvider(input: Record<string, unknown>, connector: VideoKnowledgeConnector): string {
  const provider = normalizeInput(firstString(
    input.provider,
    input.asrProvider,
    input.transcriptionProvider,
    input.transcriptProvider,
    input.asr,
    connector.config?.transcriptionProvider,
  )).toLowerCase();

  if (['gemini', 'kimi', 'api', 'whisper'].includes(provider)) {
    return provider;
  }

  const scriptPath = normalizeInput(getTranscriptionScriptPath(input, connector)).toLowerCase();

  if (scriptPath) {
    if (scriptPath.includes('kimi')) {
      return 'kimi';
    }

    if (scriptPath.includes('gemini')) {
      return 'gemini';
    }

    return 'api';
  }

  return 'gemini';
}

export function buildFullPipelineEnvironmentPreflight(
  input: Record<string, unknown>,
  connector: VideoKnowledgeConnector,
  videoId: string,
): { requirements: VideoKnowledgeEnvironmentRequirement[]; plan: Record<string, unknown> } {
  const queue = loadVideoIngestQueue(getVideoIngestQueuePath(connector));
  const job = asObjectArray(queue.jobs).find((candidate) => getVideoIdFromJob(candidate) === videoId);
  const workDir = firstString(job?.workDir) ?? join(getVideoRootPath(connector), toSafePathSegment(videoId));
  const videoPath = firstString(input.videoPath, job?.videoPath) ?? findDownloadedVideo(workDir);
  const hasVideo = Boolean(videoPath && existsSync(videoPath));
  const probePath = firstString(job?.probePath) ?? join(workDir, 'probe.json');
  const screenshotDirectory = firstString(job?.screenshotDirectory) ?? join(workDir, 'evidence_screenshots');
  const transcriptTextPath = firstString(input.transcriptTextPath, job?.transcriptTextPath)
    ?? join(workDir, 'asr', 'transcript.txt');
  const visualSummaryPath = firstString(input.visualSummaryPath, input.summaryPath, job?.visualSummaryPath)
    ?? findVisualSummaryPath(workDir);
  const hasProbe = existsSync(probePath);
  const hasScreenshots = listScreenshots(screenshotDirectory).length > 0;
  const hasTranscript = existsSync(transcriptTextPath);
  const hasVisualSummary = Boolean(visualSummaryPath && existsSync(visualSummaryPath));
  const hasBundle = existsSync(join(workDir, 'qwen-style-video-analysis-bundle.json'));
  const hasDocument = existsSync(join(workDir, 'video-report.md'))
    && existsSync(join(workDir, 'video-evidence.md'))
    && existsSync(join(workDir, 'video-document-manifest.json'));
  const force = parseBoolean(input.force, false);
  const requirements: VideoKnowledgeEnvironmentRequirement[] = [];
  const captureInput = {
    ...input,
    download: String(parseBoolean(input.download, true) && !hasVideo),
    probe: String(parseBoolean(input.probe, true) && !hasProbe),
    keyframes: String(parseBoolean(input.keyframes, true) && !hasScreenshots),
  };

  requirements.push(...buildCaptureEnvironmentRequirements(captureInput, connector));

  if (!hasTranscript || force) {
    requirements.push(...buildTranscriptionEnvironmentRequirements(input, connector));
  }

  if (!hasVisualSummary || force) {
    requirements.push(...buildVisualEnvironmentRequirements(input, connector));
  }

  if (!hasDocument && (hasBundle || hasVisualSummary) && parseBoolean(input.autoKeyframeSelection, true)) {
    requirements.push(...buildDocumentEnvironmentRequirements(input, connector));
  }

  return {
    requirements,
    plan: {
      videoId,
      workDir,
      videoPath,
      probePath,
      screenshotDirectory,
      transcriptTextPath,
      visualSummaryPath,
      hasVideo,
      hasProbe,
      hasScreenshots,
      hasTranscript,
      hasVisualSummary,
      hasBundle,
      hasDocument,
      requiredStages: {
        download: captureInput.download,
        probe: captureInput.probe,
        keyframes: captureInput.keyframes,
        transcription: String(!hasTranscript || force),
        visualAnalysis: String(!hasVisualSummary || force),
        documentKeyframeSelection: String(!hasDocument && (hasBundle || hasVisualSummary) && parseBoolean(input.autoKeyframeSelection, true)),
      },
    },
  };
}

function updateSourceInfoAfterVisualAnalysis(
  sourceInfoPath: string,
  options: {
    now: string;
    mode: string;
    visualWorkDir: string;
    visualSummaryPath: string;
    visualEvidence: boolean;
    visualSummaryStats?: {
      resultCount: number;
      usableEntries: number;
      errorCount: number;
    };
  },
): void {
  const sourceInfo = readJsonObject(sourceInfoPath) ?? {};
  const existingIngest = withoutOutOfBoundaryFields(asObject(sourceInfo.ingest) ?? {});
  const mediaEvidence = existingIngest.mediaEvidence === true;
  const transcriptEvidence = existingIngest.transcriptEvidence === true;
  const contentEvidence = existingIngest.contentEvidence === true;

  writeJsonFileAtomic(sourceInfoPath, {
    ...sourceInfo,
    ingest: {
      ...existingIngest,
      status: getStatusAfterVisualAnalysis(existingIngest.status, options.visualEvidence, transcriptEvidence, mediaEvidence, contentEvidence),
      visualAnalyzedAt: options.visualEvidence ? options.now : undefined,
      visualAnalysisCheckedAt: options.now,
      visualAnalysisMode: options.mode,
      visualWorkDir: options.visualWorkDir,
      visualSummaryPath: options.visualSummaryPath,
      visualEvidence: options.visualEvidence,
      visualSummaryStats: options.visualSummaryStats,
      contentEvidence,
      metadataOnly: !(mediaEvidence || transcriptEvidence || options.visualEvidence || contentEvidence),
    },
  });
}

function updateSourceInfoAfterBundleComposition(
  sourceInfoPath: string,
  options: {
    now: string;
    bundlePath: string;
    safeNotesPath: string;
    reportInsightsPath: string;
  },
): void {
  const sourceInfo = readJsonObject(sourceInfoPath) ?? {};
  const existingIngest = withoutOutOfBoundaryFields(asObject(sourceInfo.ingest) ?? {});

  writeJsonFileAtomic(sourceInfoPath, {
    ...sourceInfo,
    ingest: {
      ...existingIngest,
      status: 'done',
      composedAt: options.now,
      doneAt: options.now,
      bundlePath: options.bundlePath,
      safeNotesPath: options.safeNotesPath,
      reportInsightsPath: options.reportInsightsPath,
      contentEvidence: true,
      metadataOnly: false,
    },
  });
}

function updateSourceInfoAfterDocumentComposition(
  sourceInfoPath: string,
  options: {
    now: string;
    documentPath: string;
    reportPath: string;
    evidencePath: string;
    documentManifestPath: string;
    documentAssetsDir: string;
  },
): void {
  const sourceInfo = readJsonObject(sourceInfoPath) ?? {};
  const existingIngest = withoutOutOfBoundaryFields(asObject(sourceInfo.ingest) ?? {});

  writeJsonFileAtomic(sourceInfoPath, {
    ...sourceInfo,
    ingest: {
      ...existingIngest,
      status: normalizeInput(existingIngest.status) || 'done',
      documentedAt: options.now,
      documentPath: options.documentPath,
      reportPath: options.reportPath,
      evidencePath: options.evidencePath,
      documentManifestPath: options.documentManifestPath,
      documentAssetsDir: options.documentAssetsDir,
      documentEvidence: true,
    },
  });
}

function normalizeEvidenceRanges(...values: unknown[]): string[] {
  const ranges = values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => normalizeInput(value))
    .filter(Boolean);

  return [...new Set(ranges)];
}

function splitTimeRange(value: unknown): { start?: string; end?: string } {
  const range = normalizeInput(value);
  const [start, end] = range.split('-').map((part) => part.trim()).filter(Boolean);

  return {
    start,
    end,
  };
}

function compactStrings(values: unknown[], limit = 12): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const value of values) {
    const text = normalizeInput(value);

    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    results.push(text);

    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function getAnalysisEntries(visualSummary: Record<string, unknown>): Array<{
  result: Record<string, unknown>;
  analysis: Record<string, unknown>;
  range: string;
}> {
  return asObjectArray(visualSummary.results)
    .map((result) => {
      const analysis = asObject(result.analysis);

      if (!analysis || analysis.parse_error === true) {
        return undefined;
      }

      const range = firstString(analysis.segment_range, result.segment_range, result.clip_range) ?? '00:00-00:00';
      return { result, analysis, range };
    })
    .filter((entry): entry is { result: Record<string, unknown>; analysis: Record<string, unknown>; range: string } => Boolean(entry));
}

function getVisualSummaryStats(visualSummaryPath: string): {
  resultCount: number;
  usableEntries: number;
  errorCount: number;
} {
  const visualSummary = readJsonObject(visualSummaryPath) ?? {};
  const results = asObjectArray(visualSummary.results);

  return {
    resultCount: results.length,
    usableEntries: getAnalysisEntries(visualSummary).length,
    errorCount: results.filter((result) => result.error === true).length,
  };
}

type AsrSegment = {
  start_seconds: number;
  end_seconds: number;
  text: string;
  confidence?: string;
};

function loadAsrSegments(asrJsonPath: string | undefined): AsrSegment[] {
  if (!asrJsonPath || !existsSync(asrJsonPath)) {
    return [];
  }
  const data = readJsonObject(asrJsonPath);
  if (!data) {
    return [];
  }
  const out: AsrSegment[] = [];
  for (const seg of asObjectArray(data.segments)) {
    const start = valueToNumber(seg.start_seconds);
    const end = valueToNumber(seg.end_seconds);
    const text = firstString(seg.text);
    if (start === undefined || end === undefined || !text) {
      continue;
    }
    out.push({ start_seconds: start, end_seconds: end, text, confidence: firstString(seg.confidence) });
  }
  return out;
}

function mmssToSeconds(value: string): number | undefined {
  const parts = value.split(':');
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if (Number.isFinite(m) && Number.isFinite(s)) {
      return m * 60 + s;
    }
  } else if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const s = Number(parts[2]);
    if (Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s)) {
      return h * 3600 + m * 60 + s;
    }
  }
  return undefined;
}

function secondsToMmss(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function rangeToSeconds(range: string): { startSec: number; endSec: number } | undefined {
  const parts = range.split('-');
  if (parts.length !== 2) {
    return undefined;
  }
  const startSec = mmssToSeconds(parts[0].trim());
  const endSec = mmssToSeconds(parts[1].trim());
  if (startSec === undefined || endSec === undefined) {
    return undefined;
  }
  return { startSec, endSec };
}

type AsrInRange = {
  text: string;
  lines: Array<{ start: string; end: string; text: string; confidence?: string }>;
  coveredSeconds: number;
};

function asrInRange(asrSegments: AsrSegment[], startSec: number, endSec: number): AsrInRange {
  const lines: AsrInRange['lines'] = [];
  let coveredSeconds = 0;
  for (const seg of asrSegments) {
    if (seg.end_seconds <= startSec || seg.start_seconds >= endSec) {
      continue;
    }
    const overlapStart = Math.max(seg.start_seconds, startSec);
    const overlapEnd = Math.min(seg.end_seconds, endSec);
    coveredSeconds += Math.max(0, overlapEnd - overlapStart);
    lines.push({
      start: secondsToMmss(seg.start_seconds),
      end: secondsToMmss(seg.end_seconds),
      text: seg.text,
      confidence: seg.confidence,
    });
  }
  const text = lines.map((l) => l.text).join(' ').trim();
  return { text, lines, coveredSeconds };
}

function extractTopicKeywords(topic: string): string[] {
  const out = new Set<string>();
  // English / ASCII tokens (>=3 chars to skip filler like "of", "to")
  const englishTokens = topic.match(/[A-Za-z][A-Za-z0-9_]+/g) ?? [];
  for (const t of englishTokens) {
    if (t.length >= 3) {
      out.add(t);
    }
  }
  // CJK: 2-char sliding window (catches partial topic matches), plus the full phrase if it's 2-4 chars
  const cjkFillerChars = new Set(['的', '和', '或', '与', '及', '在', '是', '了', '中', '把', '让', '从', '到', '为', '于', '上', '下']);
  const cjkPhrases = topic.match(/[一-鿿]+/g) ?? [];
  for (const phrase of cjkPhrases) {
    if (phrase.length === 1) continue;
    if (phrase.length >= 2 && phrase.length <= 4) {
      out.add(phrase);
    }
    // Always also slide 2-char windows so a phrase like "积雪遮罩" matches "积雪" or "遮罩" alone in ASR
    for (let i = 0; i + 2 <= phrase.length; i++) {
      const slice = phrase.substring(i, i + 2);
      // Skip slices that are pure filler (e.g. "的中", "和的", "中的")
      if (cjkFillerChars.has(slice[0]) && cjkFillerChars.has(slice[1])) continue;
      out.add(slice);
    }
  }
  return Array.from(out);
}

function crossCheckTopicAgainstAsr(topic: string, asrText: string): {
  evidence: 'high' | 'medium' | 'none';
  matched: string[];
  total: number;
} {
  if (!asrText.trim()) {
    return { evidence: 'none', matched: [], total: 0 };
  }
  const keywords = extractTopicKeywords(topic);
  if (keywords.length === 0) {
    return { evidence: 'none', matched: [], total: 0 };
  }
  const lowerAsr = asrText.toLowerCase();
  const matched = keywords.filter((kw) => lowerAsr.includes(kw.toLowerCase()));
  const ratio = matched.length / keywords.length;
  // Tuned for sliding-window keywords: high needs either a strong density (>=40%) OR several distinct hits (>=4).
  const evidence: 'high' | 'medium' | 'none' =
    matched.length >= 4 || ratio >= 0.4
      ? 'high'
      : matched.length >= 1
        ? 'medium'
        : 'none';
  return { evidence, matched, total: keywords.length };
}


function composeOperationNotes(entries: ReturnType<typeof getAnalysisEntries>): Array<Record<string, unknown>> {
  const notes: Array<Record<string, unknown>> = [];

  for (const { analysis, range } of entries) {
    const concepts = asObjectArray(analysis.concepts);
    const operationSteps = asObjectArray(analysis.operation_steps);
    const visibleText = asObjectArray(analysis.visible_text);
    const uiEntities = asObjectArray(analysis.ui_entities);
    const signalProfile = asObject(analysis.signal_profile) ?? {};
    const leadingConcept = concepts[0];
    const leadingStep = operationSteps[0];
    const title = firstString(
      leadingConcept?.title,
      leadingStep ? `操作：${firstString(leadingStep.action, leadingStep.target) ?? range}` : undefined,
      `视频片段 ${range}`,
    );
    const purpose = firstString(
      leadingConcept?.summary,
      analysis.notes,
      operationSteps.map((step) => firstString(step.action, step.target)).filter(Boolean).join('；'),
    );
    const steps = operationSteps.map((step) => {
      const action = firstString(step.action) ?? '观察画面';
      const target = firstString(step.target);
      const input = firstString(step.input_or_value);
      const result = firstString(step.observed_result);

      return [
        action,
        target ? `目标：${target}` : undefined,
        input ? `输入/值：${input}` : undefined,
        result ? `结果：${result}` : undefined,
      ].filter(Boolean).join('；');
    });

    if (!title || (!purpose && steps.length === 0)) {
      continue;
    }

    notes.push({
      title,
      purpose,
      steps,
      evidence_ranges: normalizeEvidenceRanges(range),
      visual_terms: compactStrings([
        ...visibleText.map((entry) => entry.text),
        ...uiEntities.map((entry) => entry.name),
      ]),
      confidence: firstString(leadingConcept?.confidence, leadingStep?.confidence, signalProfile.confidence) ?? 'medium',
      needs_exact_review: asObjectArray(analysis.code_or_formula).some((entry) => entry.needs_exact_review === true),
      needs_review: [...visibleText, ...operationSteps].some((entry) => entry.needs_review === true),
    });
  }

  return notes;
}

function composeVisibleTextEvidence(entries: ReturnType<typeof getAnalysisEntries>): Array<Record<string, unknown>> {
  return entries.flatMap(({ analysis, range }) =>
    asObjectArray(analysis.visible_text)
      .map((entry) => ({
        term: firstString(entry.text),
        type: firstString(entry.source) ?? 'other',
        meaning: firstString(entry.meaning),
        evidence_ranges: normalizeEvidenceRanges(entry.time, range),
        confidence: firstString(entry.confidence) ?? 'medium',
        needs_review: entry.needs_review === true,
      }))
      .filter((entry) => Boolean(entry.term)),
  );
}

function composeFormulaCandidates(entries: ReturnType<typeof getAnalysisEntries>): Array<Record<string, unknown>> {
  return entries.flatMap(({ analysis, range }) =>
    asObjectArray(analysis.code_or_formula)
      .map((entry) => ({
        text: firstString(entry.text),
        kind: firstString(entry.kind) ?? 'unknown',
        interpretation: firstString(entry.interpretation),
        evidence_ranges: normalizeEvidenceRanges(entry.time, entry.evidence, range),
        confidence: firstString(entry.confidence) ?? 'medium',
        needs_exact_review: entry.needs_exact_review !== false,
      }))
      .filter((entry) => Boolean(entry.text)),
  );
}

function composeGotchas(entries: ReturnType<typeof getAnalysisEntries>): Array<Record<string, unknown>> {
  return entries.flatMap(({ analysis, range }) =>
    asObjectArray(analysis.gotchas)
      .map((entry) => ({
        title: firstString(entry.title) ?? '视频中的注意事项',
        symptom: firstString(entry.symptom),
        likely_cause: firstString(entry.cause, entry.likely_cause),
        fix_or_check: firstString(entry.fix, entry.fix_or_check),
        evidence_ranges: normalizeEvidenceRanges(entry.evidence, range),
        confidence: firstString(entry.confidence) ?? 'medium',
      })),
  );
}

function composeTimelineSegments(
  entries: ReturnType<typeof getAnalysisEntries>,
  asrSegments: AsrSegment[],
): Array<Record<string, unknown>> {
  return entries.map(({ analysis, range }) => {
    const concepts = asObjectArray(analysis.concepts);
    const signalProfile = asObject(analysis.signal_profile) ?? {};
    const { start, end } = splitTimeRange(range);
    const topic = firstString(concepts[0]?.title, `视频片段 ${range}`) ?? `视频片段 ${range}`;

    const rangeSeconds = rangeToSeconds(range);
    const asrPayload: AsrInRange = (rangeSeconds && asrSegments.length > 0)
      ? asrInRange(asrSegments, rangeSeconds.startSec, rangeSeconds.endSec)
      : { text: '', lines: [], coveredSeconds: 0 };

    const crossCheck = crossCheckTopicAgainstAsr(topic, asrPayload.text);

    return {
      start,
      end,
      topic,
      knowledge_value: concepts.some((concept) => concept.confidence === 'high') ? 'high' : 'medium',
      primary_signal: firstString(signalProfile.primary_signal) ?? 'visual',
      summary: firstString(concepts[0]?.summary, analysis.notes) ?? '视觉分析片段。',
      asr_text: asrPayload.text || undefined,
      asr_lines: asrPayload.lines.length > 0 ? asrPayload.lines : undefined,
      asr_covered_seconds: asrPayload.coveredSeconds > 0 ? Number(asrPayload.coveredSeconds.toFixed(2)) : undefined,
      topic_evidence: crossCheck.evidence,
      topic_matched_keywords: crossCheck.matched.length > 0 ? crossCheck.matched : undefined,
      topic_total_keywords: crossCheck.total > 0 ? crossCheck.total : undefined,
    };
  });
}

function composeInsightCandidates(entries: ReturnType<typeof getAnalysisEntries>): Array<Record<string, unknown>> {
  const candidates: Array<Record<string, unknown>> = [];

  for (const { analysis, range } of entries) {
    for (const concept of asObjectArray(analysis.concepts)) {
      const title = firstString(concept.title);

      if (!title) {
        continue;
      }

      candidates.push({
        type: 'concept',
        title,
        summary: firstString(concept.summary),
        evidence_timestamps: normalizeEvidenceRanges(concept.evidence, range),
        confidence: firstString(concept.confidence) ?? 'medium',
        report_use: 'concept_reference',
        review_note: concept.confidence === 'high' ? '高置信视频证据，可作为报告要点。' : '需要人工复核后作为报告要点。',
      });
    }

    for (const gotcha of asObjectArray(analysis.gotchas)) {
      const title = firstString(gotcha.title);

      if (!title) {
        continue;
      }

      candidates.push({
        type: 'gotcha',
        title,
        summary: compactStrings([gotcha.symptom, gotcha.fix, gotcha.fix_or_check], 3).join('；'),
        evidence_timestamps: normalizeEvidenceRanges(gotcha.evidence, range),
        confidence: firstString(gotcha.confidence) ?? 'medium',
        report_use: 'gotcha_reference',
        review_note: '常见问题或错误处理，可作为报告中的复核提示。',
      });
    }
  }

  return candidates;
}

function composeSignalProfile(entries: ReturnType<typeof getAnalysisEntries>, transcriptExists: boolean): Record<string, unknown> {
  const profiles = entries.map((entry) => asObject(entry.analysis.signal_profile) ?? {});

  return {
    content_type: 'screen_recording_tutorial',
    primary_signal: firstString(...profiles.map((profile) => profile.primary_signal)) ?? (transcriptExists ? 'both' : 'visual'),
    hard_subtitle: profiles.some((profile) => profile.has_hard_subtitles === true),
    screen_recording: profiles.some((profile) => profile.has_screen_recording === true),
    code_or_formula: profiles.some((profile) => profile.has_code_or_formula === true),
    audio_value: transcriptExists ? 'medium' : 'unknown',
  };
}

function screenshotTimeFromPath(path: string): string | undefined {
  const fileName = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const match = /(\d{4,6})/.exec(fileName);

  if (!match) {
    return undefined;
  }

  const numeric = Number(match[1]);

  if (!Number.isFinite(numeric)) {
    return undefined;
  }

  const minutes = Math.floor(numeric / 100);
  const seconds = numeric % 100;

  if (seconds >= 60) {
    return undefined;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function composeKeyScreenshots(
  workDir: string,
  operationNotes: Array<Record<string, unknown>>,
  entries: ReturnType<typeof getAnalysisEntries> = [],
): Array<Record<string, unknown>> {
  const visualFrames: Array<Record<string, unknown>> = [];

  for (const [index, entry] of entries.entries()) {
    const framePaths = Array.isArray(entry.result.frame_paths)
      ? entry.result.frame_paths.map((value) => normalizeInput(value)).filter(Boolean)
      : [];
    const frameTimes = Array.isArray(entry.result.frame_times)
      ? entry.result.frame_times.map((value) => normalizeInput(value)).filter(Boolean)
      : [];

    if (framePaths.length === 0) {
      continue;
    }

    const selectedFrameIndex = frameTimes.findIndex((time) => time && time !== splitTimeRange(entry.range).start);
    const frameIndex = selectedFrameIndex >= 0 ? selectedFrameIndex : 0;
    const path = framePaths[frameIndex] ?? framePaths[0];

    if (!path || !existsSync(path)) {
      continue;
    }

    const note = operationNotes[index % Math.max(operationNotes.length, 1)];

    visualFrames.push({
      time: frameTimes[frameIndex] ?? splitTimeRange(entry.range).start,
      title: firstString(note?.title, asObjectArray(entry.analysis.concepts)[0]?.title) ?? `关键截图 ${index + 1}`,
      path,
      why: firstString(note?.purpose, asObjectArray(entry.analysis.concepts)[0]?.summary) ?? '视频视觉证据截图。',
    });

    if (visualFrames.length >= 12) {
      break;
    }
  }

  if (visualFrames.length > 0) {
    return visualFrames;
  }

  return listScreenshots(join(workDir, 'evidence_screenshots')).slice(0, 12).map((entry, index) => {
    const path = firstString(entry.path) ?? '';
    const note = operationNotes[index % Math.max(operationNotes.length, 1)];

    return {
      time: screenshotTimeFromPath(path),
      title: firstString(note?.title) ?? `关键截图 ${index + 1}`,
      path,
      why: firstString(note?.purpose) ?? '视频视觉证据截图。',
    };
  });
}

function markdownBulletList(values: unknown[], fallback: string): string {
  const items = compactStrings(values, 12);

  if (items.length === 0) {
    return `- ${fallback}`;
  }

  return items.map((item) => `- ${item.replace(/\r?\n/g, ' ')}`).join('\n');
}

function markdownQuoteLines(values: unknown[]): string {
  const lines = compactStrings(values, 12);

  if (lines.length === 0) {
    return '> 无可用 ASR/字幕文本。';
  }

  return lines.map((line) => `> ${line.replace(/\r?\n/g, ' ')}`).join('\n');
}

function normalizeFrameTimestamp(value: unknown): string | undefined {
  const timestamp = firstString(value);

  if (!timestamp) {
    return undefined;
  }

  return timestamp.split('-')[0]?.trim() || undefined;
}

function secondsToTimestamp(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function normalizeManifestTimestamp(value: unknown): string | undefined {
  const numeric = valueToNumber(value);

  if (numeric !== undefined) {
    return secondsToTimestamp(numeric);
  }

  return normalizeFrameTimestamp(value);
}

function toSafeVariant(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'experiment';
}

function getDocumentVariant(input: Record<string, unknown>): string | undefined {
  const explicit = firstString(input.documentVariant, input.variant);

  if (explicit) {
    return toSafeVariant(explicit);
  }

  if (parseBoolean(input.experimental, false)) {
    return 'experiment';
  }

  return undefined;
}

function variantFilePath(workDir: string, baseName: string, extension: string, variant: string | undefined): string {
  return variant
    ? join(workDir, `${baseName}.${variant}.${extension}`)
    : join(workDir, `${baseName}.${extension}`);
}

function loadKeyframeManifestSelection(manifestPath: string | undefined): {
  screenshots: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
} {
  if (!manifestPath || !existsSync(manifestPath)) {
    return { screenshots: [] };
  }

  const manifest = readJsonObject(manifestPath) ?? {};
  const selected = asObjectArray(manifest.selected);
  const screenshots: Array<Record<string, unknown>> = [];

  selected.forEach((entry, index) => {
    const path = firstString(entry.path);

    if (!path || !existsSync(path)) {
      return;
    }

    const time = normalizeManifestTimestamp(entry.timestamp);
    const reasons = Array.isArray(entry.reasons)
      ? compactStrings(entry.reasons, 6)
      : compactStrings([entry.reason], 1);

    screenshots.push({
      time,
      title: firstString(entry.title) ?? `Hybrid keyframe ${index + 1}`,
      path,
      why: reasons.length > 0 ? `Hybrid keyframe selector: ${reasons.join(', ')}` : 'Hybrid keyframe selector candidate.',
      keyframeReasons: reasons,
    });
  });

  return {
    screenshots,
    metadata: {
      source: 'keyframe_manifest',
      manifestPath,
      strategy: firstString(manifest.strategy) ?? 'unknown',
      algorithm: firstString(manifest.algorithm),
      selectedCount: valueToNumber(manifest.selectedCount) ?? selected.length,
      usableScreenshots: screenshots.length,
    },
  };
}

function findDocumentVisualSummaryPath(options: {
  input: Record<string, unknown>;
  job: Record<string, unknown>;
  ingestInfo: Record<string, unknown>;
  bundle: Record<string, unknown>;
  workDir: string;
}): string | undefined {
  const bundlePaths = asObject(options.bundle.paths);
  return firstString(
    options.input.visualSummaryPath,
    options.input.semanticManifestPath,
    options.input.summaryPath,
    options.job.visualSummaryPath,
    options.ingestInfo.visualSummaryPath,
    bundlePaths?.visual_summary,
    findVisualSummaryPath(options.workDir),
  );
}

function shouldAutoSelectReportKeyframes(input: Record<string, unknown>): boolean {
  if (firstString(input.keyframeManifestPath, input.screenshotManifestPath, input.keyframeSelectionManifestPath)) {
    return false;
  }

  return parseBoolean(
    input.autoKeyframeSelection
      ?? input.autoKeyframes
      ?? input.semanticKeyframes
      ?? input.reportKeyframes,
    true,
  );
}

function getReportKeyframePreset(input: Record<string, unknown>): string {
  return normalizeInput(
    input.keyframePreset
      ?? input.keyframeSelectionPreset
      ?? input.reportKeyframePreset,
  ).toLowerCase() || 'semantic-tight';
}

function getAutoKeyframeManifestPath(options: {
  input: Record<string, unknown>;
  connector: VideoKnowledgeConnector;
  workDir: string;
  videoPath?: string;
  visualSummaryPath?: string;
}): string | undefined {
  if (!shouldAutoSelectReportKeyframes(options.input)) {
    return undefined;
  }

  const preset = getReportKeyframePreset(options.input);
  if (!['semantic-tight', 'tight', 'semantic', 'balanced'].includes(preset)) {
    return undefined;
  }

  if (!options.videoPath || !existsSync(options.videoPath)) {
    return undefined;
  }

  if (!options.visualSummaryPath || !existsSync(options.visualSummaryPath)) {
    return undefined;
  }

  const scriptPath = getKeyframeSelectorScriptPath(options.input, options.connector);
  if (!scriptPath || !existsSync(scriptPath)) {
    return undefined;
  }

  const experimentDir = join(options.workDir, '_keyframe-experiment');
  const presetName = preset === 'balanced' ? 'semantic-keyframes' : 'semantic-tight-keyframes';
  const outDir = join(experimentDir, presetName);
  const manifestPath = join(experimentDir, `${presetName}.manifest.json`);
  const force = parseBoolean(options.input.forceKeyframeSelection ?? options.input.forceKeyframes, false);

  if (existsSync(manifestPath) && !force) {
    return manifestPath;
  }

  const tight = preset !== 'balanced';
  const semanticMinScore = firstString(options.input.semanticMinScore)
    ?? (tight ? '0.80' : '0.55');
  const maxFramesPerMinute = firstString(options.input.maxFramesPerMinute)
    ?? (tight ? '3' : '6');
  const semanticWindowSeconds = firstString(options.input.semanticWindowSeconds)
    ?? (tight ? '10' : '12');
  const targetIntervalSeconds = firstString(options.input.targetIntervalSeconds)
    ?? '30';
  const diffThreshold = firstString(options.input.diffThreshold)
    ?? '0.08';
  const intervalSeconds = firstString(options.input.intervalSeconds, options.input.frameIntervalSeconds)
    ?? '2';
  const pythonPath = getPythonPath(options.input, options.connector);

  runLocalCommand(pythonPath, [
    scriptPath,
    options.videoPath,
    '--strategy',
    'hybrid',
    '--interval',
    intervalSeconds,
    '--diff-threshold',
    diffThreshold,
    '--target-interval-seconds',
    targetIntervalSeconds,
    '--semantic-manifest',
    options.visualSummaryPath,
    '--semantic-window-seconds',
    semanticWindowSeconds,
    '--semantic-min-score',
    semanticMinScore,
    '--max-frames-per-minute',
    maxFramesPerMinute,
    '--out',
    outDir,
    '--manifest',
    manifestPath,
  ], {
    cwd: options.workDir,
    step: 'keyframe-selector',
  });

  return existsSync(manifestPath) ? manifestPath : undefined;
}

function extractDocumentVideoFrame(options: {
  videoPath?: string;
  ffmpegPath: string;
  time?: string;
  assetPath: string;
  assetsDir: string;
}): boolean {
  if (!options.videoPath || !existsSync(options.videoPath) || !options.time) {
    return false;
  }

  try {
    runLocalCommand(options.ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      options.time,
      '-i',
      options.videoPath,
      '-frames:v',
      '1',
      options.assetPath,
    ], {
      cwd: options.assetsDir,
      step: 'document-frame',
    });
    return existsSync(options.assetPath);
  } catch {
    return false;
  }
}

function copyDocumentAssets(
  screenshots: Array<Record<string, unknown>>,
  assetsDir: string,
  options: {
    videoPath?: string;
    ffmpegPath?: string;
    relativeRoot?: string;
  } = {},
): Array<Record<string, unknown>> {
  mkdirSync(assetsDir, { recursive: true });
  const assets: Array<Record<string, unknown>> = [];
  const relativeRoot = normalizeInput(options.relativeRoot) || basename(assetsDir);
  const protectedSourcePaths = new Set(
    screenshots
      .map((screenshot) => firstString(screenshot.path))
      .filter((sourcePath): sourcePath is string => Boolean(sourcePath))
      .map((sourcePath) => resolve(sourcePath)),
  );

  for (const fileName of readdirSync(assetsDir)) {
    if (!/\.(?:png|jpe?g|webp)$/i.test(fileName)) {
      continue;
    }

    const assetPath = join(assetsDir, fileName);
    if (protectedSourcePaths.has(resolve(assetPath))) {
      continue;
    }

    rmSync(assetPath, { force: true });
  }

  for (const screenshot of screenshots) {
    const sourcePath = firstString(screenshot.path);

    if (!sourcePath || !existsSync(sourcePath)) {
      continue;
    }

    const fileName = basename(sourcePath);
    const assetPath = join(assetsDir, fileName);
    const relativePath = `${relativeRoot}/${fileName}`;
    const time = normalizeFrameTimestamp(screenshot.time);
    const extractedFromVideo = extractDocumentVideoFrame({
      videoPath: options.videoPath,
      ffmpegPath: options.ffmpegPath ?? 'ffmpeg',
      time,
      assetPath,
      assetsDir,
    });

    if (!extractedFromVideo) {
      copyFileSync(sourcePath, assetPath);
    }

    assets.push({
      sourcePath,
      assetPath,
      assetSource: extractedFromVideo ? 'video_frame' : 'source_frame',
      relativePath,
      time,
      title: firstString(screenshot.title),
      why: firstString(screenshot.why),
    });
  }

  return assets;
}

function isGenericVisualTitle(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return [
    'material graph editing',
    'material graph editor',
    'material graph nodes',
    'unreal engine material editor',
    'unreal engine material editor basics',
    'screen recording tutorial',
    'video tutorial',
  ].includes(normalized);
}

function selectReportTitle(options: {
  visualTitle: string;
  platformTitle: string;
  videoId: string;
}): string {
  const platformTitle = normalizeInput(options.platformTitle);
  const visualTitle = normalizeInput(options.visualTitle);

  if (platformTitle && platformTitle !== '未知' && platformTitle !== options.videoId) {
    return platformTitle;
  }

  return firstString(visualTitle, platformTitle, options.videoId) ?? options.videoId;
}

function buildReportSummary(input: {
  title: string;
  visualTitle: string;
  bundle: Record<string, unknown>;
  sourceInfo: Record<string, unknown>;
  timelineSegments: Array<Record<string, unknown>>;
  operationNotes: Array<Record<string, unknown>>;
  transcriptPreview: string[];
}): string {
  const explicitSummary = firstString(input.bundle.video_summary, input.bundle.summary, input.sourceInfo.summary);

  if (explicitSummary) {
    return explicitSummary;
  }

  const topics = compactStrings([
    ...input.timelineSegments.map((segment) => segment.topic),
    ...input.operationNotes.map((note) => note.title),
  ], 5);
  const title = firstString(input.title, input.visualTitle) ?? '该视频';
  const topicSentence = topics.length > 0
    ? `画面章节集中在 ${topics.join('、')} 等内容。`
    : '';
  const evidenceSentence = input.transcriptPreview.length > 0
    ? '报告结合画面分析和 ASR/字幕文本生成；涉及代码、参数、UI 状态时仍建议复核关键截图。'
    : '当前没有可用 ASR/字幕文本，摘要主要来自关键帧、硬字幕/OCR 和视觉模型判断；涉及代码、参数、UI 状态时仍建议复核关键截图。';

  return `这是一段围绕${title}的视频内容报告。${topicSentence}${evidenceSentence}`;
}

function formatAudioDuration(value: unknown): string | undefined {
  const duration = valueToNumber(value);

  return duration === undefined ? undefined : `约 ${Math.round(duration)} 秒`;
}

function buildAudioReportLines(input: {
  transcriptPreview: string[];
  transcriptLines: string[];
  transcriptManifest?: Record<string, unknown>;
  probe?: Record<string, unknown>;
}): string[] {
  const streams = asObjectArray(input.probe?.streams);
  const audioStreams = streams.filter((stream) => {
    const codecType = normalizeInput(stream.codec_type);

    return codecType === 'audio' || Boolean(stream.channels) || Boolean(stream.channel_layout);
  });
  const whisperStep = asObject(asObject(input.transcriptManifest?.steps)?.whisper);
  const whisperReason = normalizeInput(whisperStep?.reason);
  const audioStatus = (() => {
    if (!input.probe) {
      return '音轨：未检查（未找到 probe.json）。';
    }

    if (audioStreams.length === 0) {
      return '音轨：未发现。';
    }

    const firstAudio = audioStreams[0] ?? {};
    const codec = firstString(firstAudio.codec_name) ?? '未知编码';
    const channels = valueToNumber(firstAudio.channels);
    const duration = formatAudioDuration(firstAudio.duration);
    const details = compactStrings([
      codec,
      channels === undefined ? undefined : `${channels} 声道`,
      duration,
    ], 3).join('，');

    return `音轨：存在${details ? `（${details}）` : ''}。`;
  })();
  const asrStatus = (() => {
    if (input.transcriptLines.length > 0) {
      return `ASR：已生成（共 ${input.transcriptLines.length} 条时间戳文本，语音/音频区预览 ${input.transcriptPreview.length} 条）。`;
    }

    if (input.transcriptPreview.length > 0) {
      return `ASR：已生成（当前报告预览 ${input.transcriptPreview.length} 条时间戳文本）。`;
    }

    if (whisperReason === 'whisper_disabled') {
      return 'ASR：未生成（Whisper 未运行：当前转写步骤被禁用）。';
    }

    if (whisperReason) {
      return `ASR：未生成（Whisper 未产出文本，原因：${whisperReason}）。`;
    }

    if (input.transcriptManifest) {
      return 'ASR：未生成（已检查转写 manifest，但没有可用文本）。';
    }

    return 'ASR：未生成（未找到 transcript.txt 或 transcript-manifest.json）。';
  })();
  const lines = [
    audioStatus,
    asrStatus,
  ];

  if (input.transcriptPreview.length > 0) {
    lines.push('语音/字幕预览：');
    lines.push(...input.transcriptPreview.slice(0, 5).map((line) => `> ${line}`));
  }

  return lines;
}

function buildCommunitySection(community: Record<string, unknown>): string | undefined {
  const stats = asObject(community.stats) ?? {};
  const pinned = asObjectArray(community.pinned);
  const authorReplies = asObjectArray(community.author_replies);
  const withAuthorSub = asObjectArray(community.with_author_subreply);
  const highLikes = asObjectArray(community.high_likes);

  if (pinned.length === 0 && authorReplies.length === 0 && withAuthorSub.length === 0 && highLikes.length === 0) {
    return undefined;
  }

  const trimText = (s: string, max: number = 240): string => {
    const oneLine = s.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
  };

  // Render the `pictures` array attached to a curated comment as a list of
  // Markdown image references, indented two spaces so they nest under the
  // parent bullet. Up to 4 images per comment (rare to have more, and the
  // report stays readable).
  const renderPictures = (c: Record<string, unknown>, indent: string = '  '): string[] => {
    const pics = asObjectArray(c.pictures);
    if (pics.length === 0) return [];
    const lines: string[] = [];
    for (const pic of pics.slice(0, 4)) {
      const src = firstString(pic.img_src);
      if (!src) continue;
      const w = valueToNumber(pic.img_width);
      const h = valueToNumber(pic.img_height);
      const altDims = w && h ? ` ${w}×${h}` : '';
      lines.push(`${indent}![评论配图${altDims}](${src})`);
    }
    return lines;
  };

  const lines: string[] = [];

  if (pinned.length > 0) {
    lines.push('**置顶评论**');
    lines.push('');
    for (const c of pinned) {
      const text = firstString(c.text);
      if (!text) continue;
      const like = valueToNumber(c.like) ?? 0;
      lines.push(`- ❤${like} ${trimText(text)}`);
      lines.push(...renderPictures(c));
    }
    lines.push('');
  }

  if (authorReplies.length > 0) {
    lines.push('**作者主楼回复**');
    lines.push('');
    for (const c of authorReplies) {
      const text = firstString(c.text);
      if (!text) continue;
      const like = valueToNumber(c.like) ?? 0;
      lines.push(`- ❤${like} ${trimText(text)}`);
      lines.push(...renderPictures(c));
    }
    lines.push('');
  }

  if (withAuthorSub.length > 0) {
    lines.push('**作者在楼中楼回复**（社区追问 + 作者澄清，知识价值通常最高）');
    lines.push('');
    for (const item of withAuthorSub) {
      const main = asObject(item.main);
      const replies = asObjectArray(item.author_replies);
      const mainText = main ? firstString(main.text) : undefined;
      if (!mainText) continue;
      const mainLike = main ? valueToNumber(main.like) ?? 0 : 0;
      lines.push(`- 主楼（❤${mainLike}）：${trimText(mainText)}`);
      if (main) lines.push(...renderPictures(main, '    '));
      for (const r of replies) {
        const rt = firstString(r.text);
        if (rt) {
          lines.push(`  - 作者回：${trimText(rt)}`);
          lines.push(...renderPictures(r, '      '));
        }
      }
    }
    lines.push('');
  }

  if (highLikes.length > 0) {
    const cap = Math.min(10, highLikes.length);
    lines.push(`**高赞讨论（前 ${cap}）**`);
    lines.push('');
    for (const c of highLikes.slice(0, cap)) {
      const text = firstString(c.text);
      if (!text) continue;
      const like = valueToNumber(c.like) ?? 0;
      lines.push(`- ❤${like} ${trimText(text)}`);
      lines.push(...renderPictures(c));
    }
    lines.push('');
  }

  const fetchedAt = firstString(community.fetched_at);
  const mainFetched = valueToNumber(stats.mainCommentsFetched) ?? 0;
  const subFetched = valueToNumber(stats.subCommentsFetched) ?? 0;
  lines.push(`_评论快照：${fetchedAt ?? '未知'}（抓取主楼 ${mainFetched} 条 + 楼中楼 ${subFetched} 条，规则筛选后保留以上）_`);

  return lines.join('\n').trim();
}


function buildVideoReportMarkdown(input: {
  generatedAt: string;
  videoId: string;
  bundle: Record<string, unknown>;
  sourceInfo: Record<string, unknown>;
  transcriptPreview: string[];
  transcriptLines: string[];
  transcriptManifest?: Record<string, unknown>;
  probe?: Record<string, unknown>;
  assets: Array<Record<string, unknown>>;
}): string {
  const operationNotes = asObjectArray(input.bundle.operation_notes);
  const timelineSegments = asObjectArray(input.bundle.timeline_segments);
  const visibleTextEvidence = asObjectArray(input.bundle.visible_text_evidence);
  const formulaCandidates = asObjectArray(input.bundle.formula_or_code_candidates);
  const visualTitle = firstString(input.bundle.computed_title, input.sourceInfo.computed_title, input.sourceInfo.platform_title, input.videoId)
    ?? input.videoId;
  const platformTitle = firstString(input.bundle.platform_title, input.sourceInfo.platform_title) ?? '未知';
  const title = selectReportTitle({ visualTitle, platformTitle, videoId: input.videoId });
  const sourceUrl = firstString(input.bundle.source_url, input.sourceInfo.source_url, input.sourceInfo.webpage_url) ?? '未知';
  const duration = valueToNumber(input.bundle.duration_seconds) ?? valueToNumber(asObject(input.sourceInfo.source_metadata)?.duration);
  const keywords = compactStrings([
    ...operationNotes.map((note) => note.title),
    ...operationNotes.flatMap((note) => Array.isArray(note.visual_terms) ? note.visual_terms : []),
    ...visibleTextEvidence.map((entry) => entry.term),
    ...formulaCandidates.map((entry) => entry.text),
  ], 18);
  const primarySummary = buildReportSummary({
    title,
    visualTitle,
    bundle: input.bundle,
    sourceInfo: input.sourceInfo,
    timelineSegments,
    operationNotes,
    transcriptPreview: input.transcriptPreview,
  });
  const firstNote = operationNotes[0] ?? {};
  const sections = (timelineSegments.length > 0 ? timelineSegments : operationNotes).map((segment, index) => {
    const note = operationNotes[index] ?? firstNote;
    const asset = input.assets[index] ?? input.assets[0];
    const range = firstString(
      ...(Array.isArray(note.evidence_ranges) ? note.evidence_ranges : []),
      segment.start && segment.end ? `${segment.start}-${segment.end}` : undefined,
      segment.evidence,
    ) ?? `片段 ${index + 1}`;
    const sectionTitle = firstString(segment.topic, note.title, asset?.title) ?? `片段 ${index + 1}`;
    const imageBlock = asset ? ['', `![${sectionTitle}](${firstString(asset.relativePath)})`, ''] : ['', '_本片段没有可用截图。_', ''];
    const steps = Array.isArray(note.steps) ? note.steps : [];
    const visualTerms = compactStrings(Array.isArray(note.visual_terms) ? note.visual_terms : [], 12);

    const evidence = firstString(segment.topic_evidence);
    const evidenceTag = evidence === 'none'
      ? ' *[视觉推断·无 ASR 印证]*'
      : evidence === 'medium'
        ? ' *[ASR 部分印证]*'
        : '';
    const asrText = firstString(segment.asr_text);
    const asrBlock = asrText
      ? [
          '本段 ASR 摘录：',
          '',
          `> ${asrText.length > 400 ? asrText.slice(0, 400) + '…' : asrText}`,
          '',
        ]
      : [];

    return [
      `### ${range} ${sectionTitle}${evidenceTag}`,
      ...imageBlock,
      firstString(segment.summary, note.purpose) ?? '暂无摘要。',
      '',
      ...asrBlock,
      ...(steps.length > 0
        ? [
            '本段可观察到的操作包括：',
            '',
            ...steps.slice(0, 8).map((step) => `- ${normalizeInput(step)}`),
            '',
          ]
        : []),
      ...(visualTerms.length > 0 ? [`画面关键词：${visualTerms.join('、')}`, ''] : []),
    ].join('\n');
  });
  const formulaLines = formulaCandidates.map((entry) => {
    const text = firstString(entry.text);
    const interpretation = firstString(entry.interpretation);
    const ranges = Array.isArray(entry.evidence_ranges) ? entry.evidence_ranges.join(', ') : undefined;
    return text ? `- \`${text}\`${interpretation ? `：${interpretation}` : ''}${ranges ? `（证据时间：${ranges}）` : ''}` : undefined;
  });
  const visibleLines = visibleTextEvidence.map((entry) => {
    const term = firstString(entry.term);
    const meaning = firstString(entry.meaning);
    const ranges = Array.isArray(entry.evidence_ranges) ? entry.evidence_ranges.join(', ') : undefined;
    return term ? `- ${ranges ? `${ranges}：` : ''}${term}${meaning ? ` - ${meaning}` : ''}` : undefined;
  });
  const screenshotLines = input.assets.map((asset) => {
    const time = firstString(asset.time) ?? '未知时间';
    const relativePath = firstString(asset.relativePath) ?? '';
    const assetName = basename(firstString(asset.assetPath, relativePath) ?? relativePath);
    const assetSource = firstString(asset.assetSource) ?? 'unknown';
    return relativePath ? `- ${time}：[${assetName}](${relativePath})，来源：${assetSource}` : undefined;
  });
  const audioLines = buildAudioReportLines({
    transcriptPreview: input.transcriptPreview,
    transcriptLines: input.transcriptLines,
    transcriptManifest: input.transcriptManifest,
    probe: input.probe,
  });
  const transcriptLines = input.transcriptLines.length > 0 ? input.transcriptLines : input.transcriptPreview;

  return [
    `# ${title}`,
    '',
    input.generatedAt,
    '',
    '## 关键词',
    '',
    keywords.length > 0 ? keywords.join('  ') : '暂无关键词',
    '',
    '## 全文摘要',
    '',
    primarySummary,
    '',
    visualTitle !== platformTitle
      ? '平台标题和视觉判断标题不完全一致；平台标题保留为来源名称，内容理解请结合画面分析得到的主题。'
      : '平台标题和视觉判断标题基本一致。',
    '',
    input.transcriptPreview.length === 0
      ? '当前没有取得可用 ASR 或字幕文本，本报告主要依据画面、OCR/硬字幕和视觉模型判断生成。'
      : '本报告结合了画面识别和 ASR/字幕文本；涉及精确代码、数值和 UI 状态时仍建议复核关键截图。',
    '',
    '## 语音/音频',
    '',
    ...audioLines,
    '',
    '## 章节速览',
    '',
    sections.length > 0 ? sections.join('\n') : '_暂无可用章节。_',
    '## 要点回顾',
    '',
    '### 这段视频主要讲什么？',
    '',
    primarySummary,
    '',
    '### 画面中最值得保留的信息是什么？',
    '',
    firstString(firstNote.purpose, primarySummary) ?? '暂无明确知识点。',
    '',
    '### 这段视频能直接引用代码吗？',
    '',
    formulaCandidates.length > 0
      ? '不建议直接引用。以下代码或数值候选来自视觉模型识别和 OCR 推断，需要人工复核高清截图或原视频后再作为精确代码使用。'
      : '当前没有明显代码或公式候选；如果后续要复用精确操作，仍建议复核关键截图。',
    '',
    ...(formulaCandidates.length > 0 ? [...formulaLines.filter(Boolean), ''] : []),
    '### 为什么这类视频不能只依赖标题？',
    '',
    '录屏类视频的标题、文件名或收藏夹名称可能只提供弱上下文，甚至和内容不一致；真正的主题应由画面、字幕、ASR 和关键帧综合判断。',
    '',
    '## 画面文字与术语',
    '',
    visibleLines.filter(Boolean).join('\n') || '暂无 OCR/画面文字证据。',
    '',
    '## 代码/公式候选',
    '',
    formulaLines.filter(Boolean).join('\n') || '暂无代码或公式候选。',
    '',
    '## 截图索引',
    '',
    screenshotLines.filter(Boolean).join('\n') || '暂无截图。',
    '',
    '## 原文/字幕',
    '',
    transcriptLines.length > 0
      ? transcriptLines.map((line) => `> ${line}`).join('\n')
      : '当前样例没有取得可用 ASR 或字幕文本。本报告主要来自画面识别、OCR/硬字幕推断和关键帧视觉分析。',
    '',
    ...((): string[] => {
      const community = asObject(input.bundle.community_signals);
      if (!community) return [];
      const section = buildCommunitySection(community);
      if (!section) {
        // 评论拿过但全灌水/无价值 — 放一行说明，不占空间
        const stats = asObject(community.stats) ?? {};
        const fetched = valueToNumber(stats.mainCommentsFetched) ?? 0;
        if (fetched === 0) return [];
        return [
          '## 评论区精选',
          '',
          `_本视频共 ${fetched} 条评论，经规则筛选后无可保留内容（多为灌水或情绪表达）。原始数据见 \`comments.raw.json\`。_`,
          '',
        ];
      }
      return ['## 评论区精选', '', section, ''];
    })(),
    '## 生成说明',
    '',
    `- 视频 ID：${input.videoId}`,
    `- 来源：${sourceUrl}`,
    `- 平台标题：${platformTitle}`,
    `- 视觉判断标题：${visualTitle}`,
    `- 时长：${duration ?? '未知'}`,
    `- 截图数量：${input.assets.length}`,
    '- 文档类型：视频内容报告',
    '- 边界：本文件用于阅读和检索；是否写入 wiki、如何拆成知识页，由下游 wiki skill 处理。',
    '',
  ].join('\n');
}

function buildVideoDocumentMarkdown(input: {
  generatedAt: string;
  videoId: string;
  bundle: Record<string, unknown>;
  sourceInfo: Record<string, unknown>;
  transcriptPreview: string[];
  assets: Array<Record<string, unknown>>;
}): string {
  const operationNotes = asObjectArray(input.bundle.operation_notes);
  const timelineSegments = asObjectArray(input.bundle.timeline_segments);
  const visibleTextEvidence = asObjectArray(input.bundle.visible_text_evidence);
  const formulaCandidates = asObjectArray(input.bundle.formula_or_code_candidates);
  const gotchas = asObjectArray(input.bundle.gotchas);
  const visualTitle = firstString(input.bundle.computed_title, input.sourceInfo.computed_title, input.sourceInfo.platform_title, input.videoId)
    ?? input.videoId;
  const platformTitle = firstString(input.bundle.platform_title, input.sourceInfo.platform_title) ?? '未知';
  const title = selectReportTitle({ visualTitle, platformTitle, videoId: input.videoId });
  const sourceUrl = firstString(input.bundle.source_url, input.sourceInfo.source_url, input.sourceInfo.webpage_url) ?? '未知';
  const uploader = firstString(input.bundle.uploader, asObject(input.sourceInfo.source_metadata)?.author) ?? '未知';
  const duration = valueToNumber(input.bundle.duration_seconds) ?? valueToNumber(asObject(input.sourceInfo.source_metadata)?.duration);
  const actualTopics = compactStrings([
    ...operationNotes.map((note) => note.title),
    ...visibleTextEvidence.map((entry) => entry.term),
  ], 10);
  const sections = (timelineSegments.length > 0 ? timelineSegments : operationNotes).map((segment, index) => {
    const note = operationNotes[index] ?? operationNotes[0] ?? {};
    const asset = input.assets[index] ?? input.assets[0];
    const range = firstString(
      asObjectArray(note.evidence_ranges)[0],
      ...(Array.isArray(note.evidence_ranges) ? note.evidence_ranges : []),
      segment.start && segment.end ? `${segment.start}-${segment.end}` : undefined,
      segment.topic,
    ) ?? `片段 ${index + 1}`;
    const sectionTitle = firstString(note.title, segment.topic, asset?.title) ?? `片段 ${index + 1}`;
    const imageLine = asset
      ? `![${sectionTitle}](${firstString(asset.relativePath)})`
      : '_本片段没有可用截图。_';
    const steps = Array.isArray(note.steps) ? note.steps : [];

    return [
      `### ${range} ${sectionTitle}`,
      '',
      imageLine,
      '',
      '画面判断:',
      markdownBulletList([
        note.purpose,
        segment.summary,
        ...steps,
        ...(Array.isArray(note.visual_terms) ? note.visual_terms.map((term) => `画面可见：${term}`) : []),
      ], '暂无明确视觉判断。'),
      '',
      '音频/字幕:',
      markdownQuoteLines(input.transcriptPreview),
      '',
      '证据质量:',
      markdownBulletList([
        `视觉置信度：${firstString(note.confidence, segment.knowledge_value) ?? 'unknown'}`,
        note.needs_exact_review === true ? 'OCR/代码需要人工复核。' : '未标记精确引用风险。',
      ], '暂无证据质量判断。'),
    ].join('\n');
  });

  return [
    `# ${title}`,
    '',
    '> 本文档只提供视频证据、时间戳、截图、ASR/OCR 和 LLM 视觉判断；不执行后续改写或外部写入。',
    '',
    '## 来源',
    '',
    `- 视频 ID: ${input.videoId}`,
    `- 来源: ${sourceUrl}`,
    `- 平台标题: ${platformTitle}`,
    `- 视觉判断标题: ${visualTitle}`,
    `- 作者/UP: ${uploader}`,
    `- 时长: ${duration ?? '未知'}`,
    `- 文档生成时间: ${input.generatedAt}`,
    '',
    '## 内容识别',
    '',
    markdownBulletList([
      actualTopics.length > 0 ? `视觉推断主题：${actualTopics.join('、')}` : undefined,
      visualTitle !== platformTitle ? '平台标题和视觉判断标题不完全一致；平台标题保留为来源名称，内容理解请结合画面分析得到的主题。' : '平台标题和视觉判断标题未发现明显差异。',
    ], '暂无可用内容识别结果。'),
    '',
    '## 时间轴证据',
    '',
    sections.length > 0 ? sections.join('\n\n') : '_暂无可用时间轴片段。_',
    '',
    '## OCR/画面文本',
    '',
    markdownBulletList(
      visibleTextEvidence.map((entry) => {
        const term = firstString(entry.term);
        const meaning = firstString(entry.meaning);
        const ranges = Array.isArray(entry.evidence_ranges) ? entry.evidence_ranges.join(', ') : undefined;
        return term ? `${ranges ? `${ranges}: ` : ''}${term}${meaning ? ` - ${meaning}` : ''}` : undefined;
      }),
      '暂无 OCR/硬字幕证据。',
    ),
    '',
    '## 代码/公式候选',
    '',
    markdownBulletList(
      formulaCandidates.map((entry) => {
        const text = firstString(entry.text);
        const interpretation = firstString(entry.interpretation);
        return text ? `${text}${interpretation ? ` - ${interpretation}` : ''}` : undefined;
      }),
      '暂无代码或公式候选。',
    ),
    '',
    '## 注意事项',
    '',
    markdownBulletList(
      gotchas.map((entry) => {
        const gotchaTitle = firstString(entry.title);
        const fix = firstString(entry.fix_or_check);
        return gotchaTitle ? `${gotchaTitle}${fix ? ` - ${fix}` : ''}` : undefined;
      }),
      '暂无注意事项。',
    ),
    '',
  ].join('\n');
}

export function captureLocalVideoEvidence(
  input: Record<string, unknown>,
  context: PluginHandlerContext,
): Record<string, unknown> {
  const connector = context.connector as VideoKnowledgeConnector;
  const queuePath = getVideoIngestQueuePath(connector);
  const queue = loadVideoIngestQueue(queuePath);
  const jobs = asObjectArray(queue.jobs);
  const selected = selectLocalCaptureJob(jobs, getTargetVideoId(input));

  if (!selected) {
    return {
      queuePath,
      outcome: 'no_prepared_job',
      selected: false,
      mediaEvidence: false,
      contentEvidence: false,
      stats: getQueueStats(jobs),
    };
  }

  const now = context.now();
  const job = selected.job;
  const videoId = getVideoIdFromJob(job);

  if (!videoId) {
    throw new AppError('validation_failed', 'Prepared video ingestion job is missing a usable video id.', {
      details: { job },
    });
  }

  const workDir = firstString(job.workDir) ?? join(getVideoRootPath(connector), toSafePathSegment(videoId));
  const sourceInfoPath = firstString(job.sourceInfoPath) ?? join(workDir, 'source.info.json');
  const sourceUrl = firstString(job.sourceUrl, job.url) ?? `https://www.bilibili.com/video/${videoId}/`;
  const manifestPath = join(workDir, 'local-capture-manifest.json');
  const probePath = join(workDir, 'probe.json');
  const screenshotDirectory = join(workDir, 'evidence_screenshots');
  const frameIntervalSeconds = parseLimit(input.frameIntervalSeconds ?? input.intervalSeconds, 30);
  const maxFrames = parseLimit(input.maxFrames, 48);
  const steps: Record<string, unknown> = {};

  const configuredVideoPath = firstString(input.videoPath, job.videoPath);
  let videoPath = configuredVideoPath ?? findDownloadedVideo(workDir);
  let screenshots = listScreenshots(screenshotDirectory);
  const environmentInput = {
    ...input,
    download: String(parseBoolean(input.download, true) && !(videoPath && existsSync(videoPath))),
    probe: String(parseBoolean(input.probe, true) && !existsSync(probePath)),
    keyframes: String(parseBoolean(input.keyframes, true) && screenshots.length === 0),
  };
  const environmentRequirements = buildCaptureEnvironmentRequirements(environmentInput, connector);

  if (environmentRequirements.length > 0) {
    steps.environmentCheck = assertVideoKnowledgeEnvironmentRequirements(connector, environmentRequirements, {
      scope: 'capture-local',
      strict: true,
      stage: 'capture-local',
    });
  }

  mkdirSync(workDir, { recursive: true });

  if (videoPath && existsSync(videoPath)) {
    steps.download = {
      skipped: true,
      reason: 'video_exists',
    };
  } else if (parseBoolean(input.download, true)) {
    const ytDlpPath = getConfiguredBinary(connector, 'ytDlpPath', 'yt-dlp');
    const cookieConfig = getBilibiliCookie(connector);
    const cookieArgs = cookieConfig
      ? ['--cookies', writeBilibiliYtDlpCookieFile(workDir, cookieConfig.cookie)]
      : [];

    steps.download = {
      ...runLocalCommand(ytDlpPath, [
        '--no-playlist',
        '--merge-output-format',
        'mp4',
        '--write-info-json',
        '--no-write-playlist-metafiles',
        ...cookieArgs,
        '-o',
        join(workDir, 'video.%(ext)s'),
        sourceUrl,
      ], {
        cwd: workDir,
        step: 'download',
      }),
      bilibiliCookieUsed: Boolean(cookieConfig),
      bilibiliCookieSource: cookieConfig?.source,
    };
    videoPath = findDownloadedVideo(workDir);
  }

  if (!videoPath || !existsSync(videoPath)) {
    throw new AppError('validation_failed', 'Local video file was not found after capture download step.', {
      details: {
        videoId,
        workDir,
        sourceUrl,
        videoPath,
      },
    });
  }

  if (existsSync(probePath)) {
    steps.probe = {
      skipped: true,
      reason: 'probe_exists',
    };
  } else if (parseBoolean(input.probe, true)) {
    const ffprobePath = getConfiguredBinary(connector, 'ffprobePath', 'ffprobe');
    const probeResult = runLocalCommand(ffprobePath, [
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      videoPath,
    ], {
      cwd: workDir,
      step: 'probe',
    });
    writeJsonFileAtomic(probePath, JSON.parse(probeResult.stdout));
    steps.probe = probeResult;
  }

  mkdirSync(screenshotDirectory, { recursive: true });
  screenshots = listScreenshots(screenshotDirectory);

  if (screenshots.length > 0) {
    steps.keyframes = {
      skipped: true,
      reason: 'screenshots_exist',
    };
  } else if (parseBoolean(input.keyframes, true)) {
    const ffmpegPath = getConfiguredBinary(connector, 'ffmpegPath', 'ffmpeg');
    steps.keyframes = runLocalCommand(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      videoPath,
      '-vf',
      `fps=1/${frameIntervalSeconds},scale=960:-2`,
      '-frames:v',
      String(maxFrames),
      join(screenshotDirectory, 'shot-%06d.png'),
    ], {
      cwd: workDir,
      step: 'keyframes',
    });
    screenshots = listScreenshots(screenshotDirectory);
  }

  const mediaEvidence = existsSync(videoPath) && existsSync(probePath) && screenshots.length > 0;
  const transcriptEvidence = job.transcriptEvidence === true;
  const visualEvidence = job.visualEvidence === true;
  const contentEvidence = job.contentEvidence === true;
  const updatedJob = {
    ...withoutOutOfBoundaryFields(job),
    status: getStatusAfterCapture(job.status, mediaEvidence),
    updatedAt: now,
    capturedAt: now,
    workDir,
    sourceInfoPath,
    videoPath,
    probePath,
    screenshotDirectory,
    manifestPath,
    mediaEvidence,
    metadataOnly: !(mediaEvidence || transcriptEvidence || visualEvidence || contentEvidence),
    contentEvidence,
  };
  jobs[selected.index] = updatedJob;

  const manifest = {
    videoId,
    sourceUrl,
    capturedAt: now,
    workDir,
    sourceInfoPath,
    videoPath,
    probePath,
    screenshotDirectory,
    screenshots,
    frameIntervalSeconds,
    maxFrames,
    mediaEvidence,
    contentEvidence,
    steps,
    nextStep: 'Run ASR/OCR/vision analysis before answering content questions.',
  };

  writeJsonFileAtomic(manifestPath, manifest);
  updateSourceInfoAfterLocalCapture(sourceInfoPath, {
    now,
    manifestPath,
    videoPath,
    probePath,
    screenshotDirectory,
    mediaEvidence,
  });
  writeJsonFileAtomic(queuePath, {
    ...queue,
    version: valueToNumber(queue.version) ?? 1,
    updatedAt: now,
    jobs,
  });

  return {
    queuePath,
    outcome: mediaEvidence ? 'captured' : 'partial_capture',
    selected: true,
    workDir,
    sourceInfoPath,
    manifestPath,
    videoPath,
    probePath,
    screenshotDirectory,
    screenshots,
    mediaEvidence,
    contentEvidence,
    job: updatedJob,
    stats: getQueueStats(jobs),
    nextStep: 'Run ASR/OCR/vision analysis before answering content questions.',
  };
}

export function transcribeLocalVideoEvidence(
  input: Record<string, unknown>,
  context: PluginHandlerContext,
): Record<string, unknown> {
  const connector = context.connector as VideoKnowledgeConnector;
  const queuePath = getVideoIngestQueuePath(connector);
  const queue = loadVideoIngestQueue(queuePath);
  const jobs = asObjectArray(queue.jobs);
  const selected = selectLocalTranscriptionJob(jobs, getTargetVideoId(input));

  if (!selected) {
    return {
      queuePath,
      outcome: 'no_captured_job',
      selected: false,
      transcriptEvidence: false,
      contentEvidence: false,
      stats: getQueueStats(jobs),
    };
  }

  const now = context.now();
  const job = selected.job;
  const videoId = getVideoIdFromJob(job);

  if (!videoId) {
    throw new AppError('validation_failed', 'Captured video ingestion job is missing a usable video id.', {
      details: { job },
    });
  }

  const workDir = firstString(job.workDir) ?? join(getVideoRootPath(connector), toSafePathSegment(videoId));
  const sourceInfoPath = firstString(job.sourceInfoPath) ?? join(workDir, 'source.info.json');
  const sourceUrl = firstString(job.sourceUrl, job.url) ?? `https://www.bilibili.com/video/${videoId}/`;
  const videoPath = firstString(input.videoPath, job.videoPath) ?? findDownloadedVideo(workDir);
  const asrDir = join(workDir, 'asr');
  const transcriptManifestPath = join(asrDir, 'transcript-manifest.json');
  const canonicalTextPath = join(asrDir, 'transcript.txt');
  const canonicalJsonPath = join(asrDir, 'transcript.json');
  const canonicalSrtPath = join(asrDir, 'transcript.srt');
  const transcriptProvider = normalizeTranscriptProvider(input, connector);
  const steps: Record<string, unknown> = {};

  mkdirSync(asrDir, { recursive: true });

  let textPath = copyToCanonicalTranscriptPath(findTranscriptArtifact(asrDir, 'txt'), canonicalTextPath);
  let jsonPath = copyToCanonicalTranscriptPath(findTranscriptArtifact(asrDir, 'json'), canonicalJsonPath);
  let srtPath = copyToCanonicalTranscriptPath(findTranscriptArtifact(asrDir, 'srt'), canonicalSrtPath);
  let preview = buildTranscriptPreview(textPath);

  // If transcriptionScriptPath points at a Python wrapper (e.g. transcribe_audio_whisper.py),
  // route through the api-transcription branch even when provider=whisper. Only the
  // plain "whisper" CLI binary (no .py script) falls into the legacy CLI branch.
  const configuredScriptPath = getTranscriptionScriptPath(input, connector);
  const scriptIsPython = Boolean(
    configuredScriptPath && configuredScriptPath.toLowerCase().endsWith('.py')
  );

  if (preview.length > 0 && !parseBoolean(input.force, false)) {
    steps[transcriptProvider === 'whisper' && !scriptIsPython ? 'whisper' : 'apiTranscription'] = {
      skipped: true,
      reason: 'transcript_exists',
    };
  } else if (transcriptProvider !== 'whisper' || scriptIsPython) {
    if (!videoPath || !existsSync(videoPath)) {
      throw new AppError('validation_failed', 'Local video file is required before running API transcription.', {
        details: {
          videoId,
          workDir,
          videoPath,
        },
      });
    }

    const scriptPath = getTranscriptionScriptPath(input, connector);

    if (!scriptPath || !existsSync(scriptPath)) {
      throw new AppError('validation_failed', 'A transcriptionScriptPath is required and must exist for API transcription.', {
        details: {
          scriptPath,
          acceptedInputs: ['transcriptionScriptPath', 'scriptPath', 'connector.config.transcriptionScriptPath', 'VIDEO_KNOWLEDGE_TRANSCRIPTION_SCRIPT'],
        },
      });
    }

    const pythonPath = getPythonPath(input, connector);
    steps.environmentCheck = assertVideoKnowledgeEnvironmentRequirements(
      connector,
      buildTranscriptionEnvironmentRequirements(input, connector),
      {
        scope: 'transcribe-local',
        strict: true,
        stage: 'transcribe-local',
      },
    );
    const args = [
      scriptPath,
      '--video-path',
      videoPath,
      '--work-dir',
      workDir,
      '--asr-dir',
      asrDir,
      '--provider',
      transcriptProvider,
    ];
    const model = firstString(input.model, connector.config?.transcriptionModel, connector.config?.visionModel);
    const endpoint = firstString(input.endpoint, connector.config?.transcriptionEndpoint, connector.config?.visionEndpoint);
    const project = firstString(input.project, connector.config?.googleCloudProject);
    const location = firstString(input.location, connector.config?.googleCloudLocation);
    const language = firstString(input.language, connector.config?.transcriptionLanguage, connector.config?.whisperLanguage);
    const chunkSeconds = firstString(input.chunkSeconds, input.segmentSeconds, connector.config?.transcriptionChunkSeconds);
    const maxChunks = firstString(input.maxChunks);
    const apiKeyEnv = firstString(
      input.apiKeyEnv,
      connector.config?.transcriptionApiKeyEnv,
      connector.config?.visionApiKeyEnv,
      connector.config?.geminiApiKeyEnv,
    );
    const apiKeyFilePath = getTranscriptionApiKeyFilePath(input, connector);

    if (model) {
      args.push('--model', model);
    }

    if (endpoint) {
      args.push('--endpoint', endpoint);
    }

    if (project) {
      args.push('--project', project);
    }

    if (location) {
      args.push('--location', location);
    }

    if (language) {
      args.push('--language', language);
    }

    if (chunkSeconds) {
      args.push('--chunk-seconds', chunkSeconds);
    }

    if (maxChunks) {
      args.push('--max-chunks', maxChunks);
    }

    if (apiKeyEnv) {
      args.push('--api-key-env', apiKeyEnv);
    }

    if (apiKeyFilePath) {
      args.push('--api-key-file', apiKeyFilePath);
    }

    if (parseBoolean(input.dryRun, false)) {
      args.push('--dry-run');
    }

    steps.apiTranscription = runLocalCommand(pythonPath, args, {
      cwd: workDir,
      step: 'api-transcription',
    });

    textPath = copyToCanonicalTranscriptPath(findTranscriptArtifact(asrDir, 'txt'), canonicalTextPath);
    jsonPath = copyToCanonicalTranscriptPath(findTranscriptArtifact(asrDir, 'json'), canonicalJsonPath);
    srtPath = copyToCanonicalTranscriptPath(findTranscriptArtifact(asrDir, 'srt'), canonicalSrtPath);
    preview = buildTranscriptPreview(textPath);
  } else if (parseBoolean(input.whisper, true)) {
    if (!videoPath || !existsSync(videoPath)) {
      throw new AppError('validation_failed', 'Local video file is required before running local transcription.', {
        details: {
          videoId,
          workDir,
          videoPath,
        },
      });
    }

    const whisperPath = getConfiguredBinary(connector, 'whisperPath', 'whisper');
    const model = firstString(input.model, connector.config?.whisperModel) ?? 'turbo';
    steps.environmentCheck = assertVideoKnowledgeEnvironmentRequirements(
      connector,
      buildTranscriptionEnvironmentRequirements(input, connector),
      {
        scope: 'transcribe-local',
        strict: true,
        stage: 'transcribe-local',
      },
    );
    const args = [
      videoPath,
      '--model',
      model,
      '--output_dir',
      asrDir,
      '--output_format',
      'all',
    ];
    const language = firstString(input.language, connector.config?.whisperLanguage);
    const task = firstString(input.task);

    if (language) {
      args.push('--language', language);
    }

    if (task) {
      args.push('--task', task);
    }

    steps.whisper = runLocalCommand(whisperPath, args, {
      cwd: workDir,
      step: 'whisper',
    });

    textPath = copyToCanonicalTranscriptPath(findTranscriptArtifact(asrDir, 'txt'), canonicalTextPath);
    jsonPath = copyToCanonicalTranscriptPath(findTranscriptArtifact(asrDir, 'json'), canonicalJsonPath);
    srtPath = copyToCanonicalTranscriptPath(findTranscriptArtifact(asrDir, 'srt'), canonicalSrtPath);
    preview = buildTranscriptPreview(textPath);
  } else {
    steps.whisper = {
      skipped: true,
      reason: 'whisper_disabled',
    };
  }

  const transcriptEvidence = preview.length > 0;
  const mediaEvidence = job.mediaEvidence === true;
  const visualEvidence = job.visualEvidence === true;
  const contentEvidence = job.contentEvidence === true;
  const updatedJob = {
    ...withoutOutOfBoundaryFields(job),
    status: getStatusAfterTranscription(job.status, transcriptEvidence),
    updatedAt: now,
    transcribedAt: transcriptEvidence ? now : undefined,
    transcriptionCheckedAt: now,
    workDir,
    sourceInfoPath,
    videoPath,
    asrDir,
    transcriptManifestPath,
    transcriptTextPath: textPath,
    transcriptJsonPath: jsonPath,
    transcriptSrtPath: srtPath,
    transcriptProvider,
    transcriptEvidence,
    metadataOnly: !(mediaEvidence || visualEvidence || transcriptEvidence || contentEvidence),
    contentEvidence,
  };
  jobs[selected.index] = updatedJob;

  const manifest = {
    videoId,
    sourceUrl,
    transcribedAt: now,
    workDir,
    sourceInfoPath,
    videoPath,
    asrDir,
    textPath,
    jsonPath,
    srtPath,
    transcriptProvider,
    preview,
    transcriptEvidence,
    contentEvidence,
    steps,
    nextStep: 'Run OCR/vision analysis and report insight generation before answering content questions.',
  };

  writeJsonFileAtomic(transcriptManifestPath, manifest);
  updateSourceInfoAfterLocalTranscription(sourceInfoPath, {
    now,
    transcriptProvider,
    transcriptManifestPath,
    textPath,
    jsonPath,
    srtPath,
    transcriptEvidence,
  });
  writeJsonFileAtomic(queuePath, {
    ...queue,
    version: valueToNumber(queue.version) ?? 1,
    updatedAt: now,
    jobs,
  });

  return {
    queuePath,
    outcome: transcriptEvidence ? 'transcribed' : 'partial_transcription',
    selected: true,
    workDir,
    sourceInfoPath,
    transcriptManifestPath,
    transcriptProvider,
    transcriptEvidence,
    contentEvidence,
    transcript: {
      textPath,
      jsonPath,
      srtPath,
      preview,
    },
    job: updatedJob,
    stats: getQueueStats(jobs),
    nextStep: 'Run OCR/vision analysis and report insight generation before answering content questions.',
  };
}

export function analyzeVisualVideoEvidence(
  input: Record<string, unknown>,
  context: PluginHandlerContext,
): Record<string, unknown> {
  const connector = context.connector as VideoKnowledgeConnector;
  const queuePath = getVideoIngestQueuePath(connector);
  const queue = loadVideoIngestQueue(queuePath);
  const jobs = asObjectArray(queue.jobs);
  const selected = selectLocalVisualAnalysisJob(jobs, getTargetVideoId(input));

  if (!selected) {
    return {
      queuePath,
      outcome: 'no_captured_job',
      selected: false,
      visualEvidence: false,
      contentEvidence: false,
      stats: getQueueStats(jobs),
    };
  }

  const now = context.now();
  const job = selected.job;
  const videoId = getVideoIdFromJob(job);

  if (!videoId) {
    throw new AppError('validation_failed', 'Captured video ingestion job is missing a usable video id.', {
      details: { job },
    });
  }

  const workDir = firstString(job.workDir) ?? join(getVideoRootPath(connector), toSafePathSegment(videoId));
  const sourceInfoPath = firstString(job.sourceInfoPath) ?? join(workDir, 'source.info.json');
  const videoPath = firstString(input.videoPath, job.videoPath) ?? findDownloadedVideo(workDir);
  const scriptPath = getVisualAnalysisScriptPath(input, connector);
  const mode = getVisualAnalysisMode(input);
  const visualWorkDir = firstString(input.visualWorkDir, input.workDir) ?? getVisualAnalysisWorkDir(workDir, mode);
  const visualSummaryPath = firstString(input.summaryPath) ?? getVisualAnalysisSummaryPath(visualWorkDir, mode);
  const steps: Record<string, unknown> = {};

  if (!videoPath || !existsSync(videoPath)) {
    throw new AppError('validation_failed', 'Local video file is required before running visual analysis.', {
      details: {
        videoId,
        workDir,
        videoPath,
      },
    });
  }

  mkdirSync(visualWorkDir, { recursive: true });

  if (existsSync(visualSummaryPath) && !parseBoolean(input.force, false)) {
    steps.visualAnalysis = {
      skipped: true,
      reason: 'visual_summary_exists',
    };
  } else {
    steps.environmentCheck = assertVideoKnowledgeEnvironmentRequirements(
      connector,
      buildVisualEnvironmentRequirements(input, connector),
      {
        scope: 'analyze-visual',
        strict: true,
        stage: 'analyze-visual',
      },
    );

    if (!scriptPath || !existsSync(scriptPath)) {
      throw new AppError('validation_failed', 'A visual analysis scriptPath is required and must exist.', {
        details: {
          scriptPath,
          acceptedInputs: ['scriptPath', 'connector.config.visualAnalysisScriptPath', 'VIDEO_KNOWLEDGE_VISUAL_ANALYSIS_SCRIPT'],
        },
      });
    }

    const pythonPath = getPythonPath(input, connector);
    const args = [
      scriptPath,
      '--video-path',
      videoPath,
      '--work-dir',
      visualWorkDir,
      '--mode',
      mode,
    ];

    const model = firstString(input.model, connector.config?.visionModel);
    const endpoint = firstString(input.endpoint, connector.config?.visionEndpoint);
    const project = firstString(input.project, connector.config?.googleCloudProject);
    const location = firstString(input.location, connector.config?.googleCloudLocation);
    const segmentSeconds = firstString(input.segmentSeconds, input.chunkSeconds);
    const frameInterval = firstString(input.frameInterval);
    const maxSegments = firstString(input.maxSegments);
    const sleepSeconds = firstString(input.sleepSeconds);
    const apiKeyEnv = firstString(input.apiKeyEnv, connector.config?.visionApiKeyEnv, connector.config?.geminiApiKeyEnv);
    const apiKeyFilePath = getVisualApiKeyFilePath(input, connector);

    if (model) {
      args.push('--model', model);
    }

    if (endpoint) {
      args.push('--endpoint', endpoint);
    }

    if (project) {
      args.push('--project', project);
    }

    if (location) {
      args.push('--location', location);
    }

    if (segmentSeconds) {
      args.push('--segment-seconds', segmentSeconds);
    }

    if (frameInterval) {
      args.push('--frame-interval', frameInterval);
    }

    if (maxSegments) {
      args.push('--max-segments', maxSegments);
    }

    if (sleepSeconds) {
      args.push('--sleep-seconds', sleepSeconds);
    }

    if (apiKeyEnv) {
      args.push('--api-key-env', apiKeyEnv);
    }

    if (apiKeyFilePath) {
      args.push('--api-key-file', apiKeyFilePath);
    }

    if (parseBoolean(input.dryRun, false)) {
      args.push('--dry-run');
    }

    steps.visualAnalysis = runLocalCommand(pythonPath, args, {
      cwd: workDir,
      step: 'visual-analysis',
    });
  }

  const visualSummaryStats = existsSync(visualSummaryPath)
    ? getVisualSummaryStats(visualSummaryPath)
    : { resultCount: 0, usableEntries: 0, errorCount: 0 };
  const visualEvidence = visualSummaryStats.usableEntries > 0;
  const mediaEvidence = job.mediaEvidence === true;
  const transcriptEvidence = job.transcriptEvidence === true;
  const contentEvidence = job.contentEvidence === true;
  const updatedJob = {
    ...withoutOutOfBoundaryFields(job),
    status: getStatusAfterVisualAnalysis(job.status, visualEvidence, transcriptEvidence, mediaEvidence, contentEvidence),
    updatedAt: now,
    visualAnalyzedAt: visualEvidence ? now : undefined,
    visualAnalysisCheckedAt: now,
    workDir,
    sourceInfoPath,
    videoPath,
    visualAnalysisMode: mode,
    visualWorkDir,
    visualSummaryPath,
    visualEvidence,
    visualSummaryStats,
    metadataOnly: !(mediaEvidence || transcriptEvidence || visualEvidence || contentEvidence),
    contentEvidence,
  };
  jobs[selected.index] = updatedJob;

  updateSourceInfoAfterVisualAnalysis(sourceInfoPath, {
    now,
    mode,
    visualWorkDir,
    visualSummaryPath,
    visualEvidence,
    visualSummaryStats,
  });
  writeJsonFileAtomic(queuePath, {
    ...queue,
    version: valueToNumber(queue.version) ?? 1,
    updatedAt: now,
    jobs,
  });

  return {
    queuePath,
    outcome: visualEvidence ? 'visual_analyzed' : 'partial_visual_analysis',
    selected: true,
    workDir,
    sourceInfoPath,
    videoPath,
    mode,
    visualWorkDir,
    visualSummaryPath,
    visualEvidence,
    visualSummaryStats,
    contentEvidence,
    steps,
    job: updatedJob,
    stats: getQueueStats(jobs),
    nextStep: visualEvidence
      ? 'Merge transcript and visual analysis into operation notes, report insights, and the final evidence bundle.'
      : 'Run visual analysis with a configured provider before composing the final evidence bundle.',
  };
}

export function composeVideoEvidenceBundle(
  input: Record<string, unknown>,
  context: PluginHandlerContext,
): Record<string, unknown> {
  const connector = context.connector as VideoKnowledgeConnector;
  const queuePath = getVideoIngestQueuePath(connector);
  const queue = loadVideoIngestQueue(queuePath);
  const jobs = asObjectArray(queue.jobs);
  const selected = selectBundleCompositionJob(jobs, getTargetVideoId(input));

  if (!selected) {
    return {
      queuePath,
      outcome: 'no_visual_analysis_job',
      selected: false,
      contentEvidence: false,
      stats: getQueueStats(jobs),
    };
  }

  const now = context.now();
  const job = selected.job;
  const videoId = getVideoIdFromJob(job);

  if (!videoId) {
    throw new AppError('validation_failed', 'Visual analysis ingestion job is missing a usable video id.', {
      details: { job },
    });
  }

  const workDir = firstString(job.workDir) ?? join(getVideoRootPath(connector), toSafePathSegment(videoId));
  const sourceInfoPath = firstString(job.sourceInfoPath) ?? join(workDir, 'source.info.json');
  const sourceInfo = readJsonObject(sourceInfoPath) ?? {};
  const ingestInfo = asObject(sourceInfo.ingest) ?? {};
  const visualSummaryPath = firstString(
    input.visualSummaryPath,
    input.summaryPath,
    job.visualSummaryPath,
    ingestInfo.visualSummaryPath,
  ) ?? findVisualSummaryPath(workDir);
  const transcriptTextPath = firstString(input.transcriptTextPath, job.transcriptTextPath, ingestInfo.transcriptTextPath)
    ?? join(workDir, 'asr', 'transcript.txt');
  const bundlePath = join(workDir, 'qwen-style-video-analysis-bundle.json');
  const safeNotesPath = join(workDir, 'hard-subtitle-operation-notes.safe.json');
  const reportInsightsPath = join(workDir, 'video-report-insights.json');

  if (!visualSummaryPath || !existsSync(visualSummaryPath)) {
    throw new AppError('validation_failed', 'A visual analysis summary is required before composing a video knowledge bundle.', {
      details: {
        videoId,
        workDir,
        visualSummaryPath,
      },
    });
  }

  const visualSummary = readJsonObject(visualSummaryPath) ?? {};
  const entries = getAnalysisEntries(visualSummary);

  if (entries.length === 0) {
    throw new AppError('validation_failed', 'Visual analysis summary did not contain usable analysis entries.', {
      details: {
        visualSummaryPath,
        resultCount: asObjectArray(visualSummary.results).length,
      },
    });
  }

  const transcriptText = readTextFile(transcriptTextPath);
  const transcriptExists = Boolean(transcriptText?.trim());
  const transcriptJsonPath = transcriptTextPath.replace(/transcript\.txt$/, 'transcript.json');
  const asrSegments = loadAsrSegments(transcriptJsonPath);
  const commentsCuratedPath = join(workDir, 'comments.curated.json');
  const communitySignals = existsSync(commentsCuratedPath)
    ? (readJsonObject(commentsCuratedPath) ?? undefined)
    : undefined;
  const operationNotes = composeOperationNotes(entries);
  const visibleTextEvidence = composeVisibleTextEvidence(entries);
  const formulaOrCodeCandidates = composeFormulaCandidates(entries);
  const gotchas = composeGotchas(entries);
  const timelineSegments = composeTimelineSegments(entries, asrSegments);
  const insightCandidates = composeInsightCandidates(entries);
  const computedTitle = firstString(
    operationNotes[0]?.title,
    insightCandidates[0]?.title,
    sourceInfo.computed_title,
    sourceInfo.platform_title,
    job.title,
    videoId,
  ) ?? videoId;
  const signalProfile = composeSignalProfile(entries, transcriptExists);
  const keyScreenshots = composeKeyScreenshots(workDir, operationNotes, entries);
  const contentEvidence = operationNotes.length > 0 || visibleTextEvidence.length > 0 || insightCandidates.length > 0;

  const safeNotes = {
    video_id: videoId,
    computed_title: computedTitle,
    signal_profile: signalProfile,
    operation_notes: operationNotes,
    visible_text_evidence: visibleTextEvidence,
    formula_or_code_candidates: formulaOrCodeCandidates,
    gotchas,
    agent_usage: {
      can_answer_how_to: operationNotes.length > 0,
      safe_to_quote_exact_code: false,
      recommended_answer_style: '优先回答操作步骤、概念和可复核证据；精确代码需复看关键帧或原视频。',
      when_to_rewatch: entries.flatMap((entry) => asObjectArray(entry.analysis.needs_rewatch)).slice(0, 8),
    },
  };
  const reportInsights = {
    video_id: videoId,
    computed_title: computedTitle,
    title_reliability: 'visual_inferred',
    content_type: 'tutorial',
    primary_signal: signalProfile.primary_signal,
    sync_status: 'unknown',
    video_summary: timelineSegments.map((segment) => segment.summary).filter(Boolean).slice(0, 5).join('；'),
    timeline_segments: timelineSegments,
    insight_candidates: insightCandidates,
    recommended_report_sections: compactStrings([
      ...insightCandidates.map((candidate) => candidate.title),
      ...visibleTextEvidence.map((entry) => entry.term),
    ], 12),
    needs_rewatch: entries.flatMap((entry) => asObjectArray(entry.analysis.needs_rewatch)).slice(0, 12),
    ingestion_verdict: contentEvidence ? 'usable_visual_evidence' : 'needs_more_analysis',
  };
  const bundle = {
    video_id: videoId,
    source_url: firstString(sourceInfo.source_url, sourceInfo.webpage_url, job.sourceUrl, job.url),
    platform_title: firstString(sourceInfo.platform_title, job.title),
    computed_title: computedTitle,
    uploader: firstString(asObject(sourceInfo.source_metadata)?.author, job.author),
    duration_seconds: valueToNumber(asObject(sourceInfo.source_metadata)?.duration) ?? valueToNumber(visualSummary.duration_seconds),
    local_video: firstString(job.videoPath, ingestInfo.videoPath),
    asr: {
      txt_path: existsSync(transcriptTextPath) ? transcriptTextPath : undefined,
      preview: buildTranscriptPreview(existsSync(transcriptTextPath) ? transcriptTextPath : undefined),
    },
    community_signals: communitySignals,
    signal_profile: signalProfile,
    timeline_segments: timelineSegments,
    operation_notes: operationNotes,
    visible_text_evidence: visibleTextEvidence,
    formula_or_code_candidates: formulaOrCodeCandidates,
    gotchas,
    key_screenshots: keyScreenshots,
    agent_usage: safeNotes.agent_usage,
    paths: {
      report_insights: reportInsightsPath,
      operation_notes_safe: safeNotesPath,
      visual_summary: visualSummaryPath,
      transcript: existsSync(transcriptTextPath) ? transcriptTextPath : undefined,
    },
  };

  writeJsonFileAtomic(safeNotesPath, safeNotes);
  writeJsonFileAtomic(reportInsightsPath, reportInsights);
  writeJsonFileAtomic(bundlePath, bundle);

  const updatedJob = {
    ...withoutOutOfBoundaryFields(job),
    status: contentEvidence ? 'done' : normalizeInput(job.status) || 'visual_analyzed',
    updatedAt: now,
    doneAt: contentEvidence ? now : undefined,
    composedAt: now,
    workDir,
    sourceInfoPath,
    visualSummaryPath,
    bundlePath,
    safeNotesPath,
    reportInsightsPath,
    contentEvidence,
    metadataOnly: !contentEvidence,
  };
  jobs[selected.index] = updatedJob;

  updateSourceInfoAfterBundleComposition(sourceInfoPath, {
    now,
    bundlePath,
    safeNotesPath,
    reportInsightsPath,
  });
  writeJsonFileAtomic(queuePath, {
    ...queue,
    version: valueToNumber(queue.version) ?? 1,
    updatedAt: now,
    jobs,
  });

  return {
    queuePath,
    outcome: contentEvidence ? 'composed' : 'partial_composition',
    selected: true,
    workDir,
    sourceInfoPath,
    visualSummaryPath,
    bundlePath,
    safeNotesPath,
    reportInsightsPath,
    contentEvidence,
    counts: {
      operationNotes: operationNotes.length,
      visibleTextEvidence: visibleTextEvidence.length,
      formulaOrCodeCandidates: formulaOrCodeCandidates.length,
      gotchas: gotchas.length,
      insightCandidates: insightCandidates.length,
      keyScreenshots: keyScreenshots.length,
    },
    job: updatedJob,
    stats: getQueueStats(jobs),
    nextStep: contentEvidence
      ? 'Use video.knowledge.search/get to answer from the composed evidence bundle.'
      : 'Run more visual analysis before composing a final evidence bundle.',
  };
}

export function composeVideoEvidenceDocument(
  input: Record<string, unknown>,
  context: PluginHandlerContext,
): Record<string, unknown> {
  const connector = context.connector as VideoKnowledgeConnector;
  const queuePath = getVideoIngestQueuePath(connector);
  const queue = loadVideoIngestQueue(queuePath);
  const jobs = asObjectArray(queue.jobs);
  const selected = selectBundleCompositionJob(jobs, getTargetVideoId(input));

  if (!selected) {
    return {
      queuePath,
      outcome: 'no_composed_job',
      selected: false,
      documentEvidence: false,
      stats: getQueueStats(jobs),
    };
  }

  const now = context.now();
  const job = selected.job;
  const videoId = getVideoIdFromJob(job);

  if (!videoId) {
    throw new AppError('validation_failed', 'Composed video ingestion job is missing a usable video id.', {
      details: { job },
    });
  }

  const workDir = firstString(job.workDir) ?? join(getVideoRootPath(connector), toSafePathSegment(videoId));
  const sourceInfoPath = firstString(job.sourceInfoPath) ?? join(workDir, 'source.info.json');
  const sourceInfo = readJsonObject(sourceInfoPath) ?? {};
  const ingestInfo = asObject(sourceInfo.ingest) ?? {};
  const bundlePath = firstString(input.bundlePath, job.bundlePath, ingestInfo.bundlePath)
    ?? join(workDir, 'qwen-style-video-analysis-bundle.json');
  const transcriptTextPath = firstString(input.transcriptTextPath, job.transcriptTextPath, ingestInfo.transcriptTextPath)
    ?? firstString(asObject(asObject(readJsonObject(bundlePath))?.asr)?.txt_path)
    ?? join(workDir, 'asr', 'transcript.txt');
  const transcriptManifestPath = firstString(input.transcriptManifestPath, job.transcriptManifestPath, ingestInfo.transcriptManifestPath)
    ?? join(workDir, 'asr', 'transcript-manifest.json');
  const probePath = firstString(input.probePath, job.probePath, ingestInfo.probePath)
    ?? join(workDir, 'probe.json');
  const documentVariant = getDocumentVariant(input);
  const experimental = Boolean(documentVariant);
  const documentPath = firstString(input.documentPath, input.reportPath)
    ?? (experimental ? undefined : firstString(job.reportPath, ingestInfo.reportPath))
    ?? variantFilePath(workDir, 'video-report', 'md', documentVariant);
  const reportPath = documentPath;
  const evidencePath = firstString(input.evidencePath)
    ?? (experimental ? undefined : firstString(job.evidencePath, ingestInfo.evidencePath))
    ?? variantFilePath(workDir, 'video-evidence', 'md', documentVariant);
  const documentManifestPath = firstString(input.documentManifestPath)
    ?? (experimental ? undefined : firstString(job.documentManifestPath, ingestInfo.documentManifestPath))
    ?? variantFilePath(workDir, 'video-document-manifest', 'json', documentVariant);
  const documentAssetsDir = firstString(input.documentAssetsDir, input.assetsDir)
    ?? (experimental ? undefined : firstString(job.documentAssetsDir, ingestInfo.documentAssetsDir))
    ?? join(workDir, documentVariant ? `document-assets-${documentVariant}` : 'document-assets');

  if (!existsSync(bundlePath)) {
    throw new AppError('validation_failed', 'A composed evidence bundle is required before composing a video document.', {
      details: {
        videoId,
        workDir,
        bundlePath,
      },
    });
  }

  const bundle = readJsonObject(bundlePath) ?? {};
  const transcriptManifest = existsSync(transcriptManifestPath) ? readJsonObject(transcriptManifestPath) : undefined;
  const probe = existsSync(probePath) ? readJsonObject(probePath) : undefined;
  const videoPath = firstString(input.videoPath, job.videoPath, ingestInfo.videoPath, bundle.local_video, bundle.source_video);
  const visualSummaryPath = findDocumentVisualSummaryPath({
    input,
    job,
    ingestInfo,
    bundle,
    workDir,
  });
  const keyframeManifestPath = firstString(input.keyframeManifestPath, input.screenshotManifestPath, input.keyframeSelectionManifestPath)
    ?? getAutoKeyframeManifestPath({
      input,
      connector,
      workDir,
      videoPath,
      visualSummaryPath,
    });
  const keyframeSelection = loadKeyframeManifestSelection(keyframeManifestPath);
  const screenshots = keyframeSelection.screenshots.length > 0
    ? keyframeSelection.screenshots
    : asObjectArray(bundle.key_screenshots);
  const ffmpegPath = getConfiguredBinary(connector, 'ffmpegPath', 'ffmpeg');
  const assets = copyDocumentAssets(screenshots, documentAssetsDir, {
    videoPath,
    ffmpegPath,
    relativeRoot: basename(documentAssetsDir),
  });
  const transcriptLines = buildTranscriptLines(existsSync(transcriptTextPath) ? transcriptTextPath : undefined);
  const transcriptPreview = transcriptLines.slice(0, 12);
  const reportMarkdown = buildVideoReportMarkdown({
    generatedAt: now,
    videoId,
    bundle,
    sourceInfo,
    transcriptPreview,
    transcriptLines,
    transcriptManifest,
    probe,
    assets,
  });
  const evidenceMarkdown = buildVideoDocumentMarkdown({
    generatedAt: now,
    videoId,
    bundle,
    sourceInfo,
    transcriptPreview,
    assets,
  });
  const boundary = {
    scope: 'video_report_only',
    outputOnly: true,
    note: 'This project generates video reports and evidence documents only.',
  };
  const manifestVisualTitle = firstString(bundle.computed_title, sourceInfo.computed_title, sourceInfo.platform_title, videoId)
    ?? videoId;
  const manifestPlatformTitle = firstString(bundle.platform_title, sourceInfo.platform_title) ?? '未知';
  const manifest = {
    videoId,
    documentType: experimental ? 'video_report_experimental' : 'video_report',
    experimental,
    canonical: !experimental,
    ...(documentVariant ? { documentVariant } : {}),
    generatedAt: now,
    documentPath,
    reportPath,
    evidencePath,
    assetsDirectory: documentAssetsDir,
    videoPath,
    sourceInfoPath,
    bundlePath,
    transcriptTextPath: existsSync(transcriptTextPath) ? transcriptTextPath : undefined,
    title: selectReportTitle({ visualTitle: manifestVisualTitle, platformTitle: manifestPlatformTitle, videoId }),
    visualTitle: manifestVisualTitle,
    platformTitle: manifestPlatformTitle,
    sourceUrl: firstString(bundle.source_url, sourceInfo.source_url, sourceInfo.webpage_url),
    boundary,
    ...(keyframeSelection.metadata ? { keyframeSelection: keyframeSelection.metadata } : {}),
    assets,
  };

  writeFileSync(reportPath, reportMarkdown, 'utf8');
  writeFileSync(evidencePath, evidenceMarkdown, 'utf8');
  writeJsonFileAtomic(documentManifestPath, manifest);

  const updatedJob = experimental
    ? withoutOutOfBoundaryFields(job)
    : {
        ...withoutOutOfBoundaryFields(job),
        updatedAt: now,
        documentedAt: now,
        workDir,
        sourceInfoPath,
        bundlePath,
        documentPath,
        reportPath,
        evidencePath,
        documentManifestPath,
        documentAssetsDir,
        videoPath,
        documentEvidence: true,
      };

  if (!experimental) {
    jobs[selected.index] = updatedJob;

    updateSourceInfoAfterDocumentComposition(sourceInfoPath, {
      now,
      documentPath,
      reportPath,
      evidencePath,
      documentManifestPath,
      documentAssetsDir,
    });
    writeJsonFileAtomic(queuePath, {
      ...queue,
      version: valueToNumber(queue.version) ?? 1,
      updatedAt: now,
      jobs,
    });
  }

  return {
    queuePath,
    outcome: 'documented',
    selected: true,
    experimental,
    canonical: !experimental,
    ...(documentVariant ? { documentVariant } : {}),
    workDir,
    videoPath,
    sourceInfoPath,
    bundlePath,
    documentPath,
    reportPath,
    evidencePath,
    documentManifestPath,
    documentAssetsDir,
    documentEvidence: true,
    boundary,
    ...(keyframeSelection.metadata ? { keyframeSelection: keyframeSelection.metadata } : {}),
    assets,
    counts: {
      screenshots: screenshots.length,
      documentAssets: assets.length,
      videoFrameAssets: assets.filter((asset) => asset.assetSource === 'video_frame').length,
      sourceFrameAssets: assets.filter((asset) => asset.assetSource === 'source_frame').length,
      copiedAssets: assets.length,
      transcriptPreview: transcriptPreview.length,
      transcriptLines: transcriptLines.length,
    },
    job: updatedJob,
    stats: getQueueStats(jobs),
    nextStep: experimental
      ? `Read ${basename(reportPath)} for the experimental human-facing report; use ${basename(evidencePath)} and ${basename(documentManifestPath)} for audit or handoff. Canonical video-report.md was not replaced.`
      : 'Read video-report.md for the human-facing report; use video-evidence.md and video-document-manifest.json for audit or handoff.',
  };
}

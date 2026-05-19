import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  asNumber,
  asObjectArray,
  asString,
  failVideoKnowledgeDataError,
  firstString,
  readJsonObject,
  readTextFile,
  transcriptInvalidReason,
  uniqueByTitle,
} from './common.js';
import { getVideoRootPath } from './paths.js';
import { getTranscriptPreview } from './search.js';
import type { VideoKnowledgeConnector, VideoKnowledgeRecord } from './types.js';

function discoverScreenshots(videoPath: string): Array<Record<string, unknown>> {
  const screenshotDirectory = join(videoPath, 'evidence_screenshots');

  if (!existsSync(screenshotDirectory)) {
    return [];
  }

  return readdirSync(screenshotDirectory)
    .filter((fileName) => /\.(png|jpg|jpeg|webp)$/i.test(fileName))
    .map((fileName) => ({
      path: join(screenshotDirectory, fileName),
    }));
}

function loadVideoRecord(videoPath: string): VideoKnowledgeRecord {
  const bundlePath = join(videoPath, 'qwen-style-video-analysis-bundle.json');
  const safeNotesPath = join(videoPath, 'hard-subtitle-operation-notes.safe.json');
  const reportInsightsPath = join(videoPath, 'video-report-insights.json');
  const reportPath = join(videoPath, 'video-report.md');
  const evidencePath = join(videoPath, 'video-evidence.md');
  const documentManifestPath = join(videoPath, 'video-document-manifest.json');
  const transcriptPath = join(videoPath, 'asr', 'transcript.txt');
  const bundle = readJsonObject(bundlePath) ?? {};
  const safeNotes = readJsonObject(safeNotesPath) ?? {};
  const reportInsights = readJsonObject(reportInsightsPath) ?? {};
  const transcriptText = readTextFile(transcriptPath);
  const invalidTranscriptReason = transcriptInvalidReason(transcriptText);
  const videoId = firstString(bundle.video_id, safeNotes.video_id, reportInsights.video_id) ?? basename(videoPath);
  const keyScreenshots = asObjectArray(bundle.key_screenshots);

  return {
    videoId,
    title: firstString(bundle.platform_title, reportInsights.platform_title, safeNotes.platform_title, bundle.computed_title, safeNotes.computed_title, reportInsights.computed_title) ?? videoId,
    sourceUrl: asString(bundle.source_url),
    platformTitle: asString(bundle.platform_title),
    uploader: asString(bundle.uploader),
    durationSeconds: asNumber(bundle.duration_seconds),
    signalProfile: (bundle.signal_profile ?? safeNotes.signal_profile) as Record<string, unknown> | undefined,
    timelineSegments: asObjectArray(bundle.timeline_segments ?? reportInsights.timeline_segments),
    operationNotes: uniqueByTitle([
      ...asObjectArray(safeNotes.operation_notes),
      ...asObjectArray(bundle.operation_notes),
    ]),
    visibleTextEvidence: uniqueByTitle([
      ...asObjectArray(safeNotes.visible_text_evidence),
      ...asObjectArray(bundle.visible_text_evidence),
    ]),
    formulaOrCodeCandidates: uniqueByTitle([
      ...asObjectArray(safeNotes.formula_or_code_candidates),
      ...asObjectArray(bundle.formula_or_code_candidates),
    ]),
    gotchas: uniqueByTitle([
      ...asObjectArray(safeNotes.gotchas),
      ...asObjectArray(bundle.gotchas),
    ]),
    agentUsage: (safeNotes.agent_usage ?? bundle.agent_usage) as Record<string, unknown> | undefined,
    videoValue: (bundle.video_value ?? reportInsights.video_value) as Record<string, unknown> | undefined,
    keyScreenshots: keyScreenshots.length > 0 ? keyScreenshots : discoverScreenshots(videoPath),
    transcript: {
      path: existsSync(transcriptPath) ? transcriptPath : undefined,
      preview: invalidTranscriptReason ? [] : getTranscriptPreview(transcriptText),
      invalidReason: invalidTranscriptReason,
    },
    paths: {
      videoPath,
      bundlePath,
      safeNotesPath,
      reportInsightsPath,
      transcriptPath,
      ...(existsSync(reportPath) ? { reportPath } : {}),
      ...(existsSync(evidencePath) ? { evidencePath } : {}),
      ...(existsSync(documentManifestPath) ? { documentManifestPath } : {}),
    },
  };
}

function listVideoPaths(rootPath: string): string[] {
  if (!existsSync(rootPath)) {
    failVideoKnowledgeDataError(`Video knowledge root ${rootPath} was not found.`, {
      rootPath,
      reason: 'missing_root',
    });
  }

  return readdirSync(rootPath)
    .map((entryName) => join(rootPath, entryName))
    .filter((entryPath) => {
      try {
        return statSync(entryPath).isDirectory();
      } catch {
        return false;
      }
    });
}

export function loadVideos(connector: VideoKnowledgeConnector): VideoKnowledgeRecord[] {
  return listVideoPaths(getVideoRootPath(connector)).map(loadVideoRecord);
}

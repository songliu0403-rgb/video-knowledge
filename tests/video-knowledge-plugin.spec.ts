import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorRuntime } from '../src/connectors/connector-manager.js';
import { getBilibiliCookie } from '../src/plugins/plugin-video-knowledge/paths.js';
import { CapabilityRegistry } from '../src/registry/capability-registry.js';
import { loadPlugins } from '../src/registry/plugin-loader.js';

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createVideoRoot(): string {
  const rootPath = mkdtempSync(join(tmpdir(), 'video-knowledge-'));
  const videoPath = join(rootPath, 'BV_TEST');
  const transcriptTextPath = join(videoPath, 'asr', 'transcript.txt');
  const keyframeManifestPath = join(videoPath, '_keyframe-experiment', 'semantic-tight-keyframes.manifest.json');

  mkdirSync(join(videoPath, 'asr'), { recursive: true });
  mkdirSync(join(videoPath, 'evidence_screenshots'), { recursive: true });
  mkdirSync(join(videoPath, '_keyframe-experiment'), { recursive: true });
  writeFileSync(join(videoPath, 'evidence_screenshots', 'shot-000815.png'), 'fake image bytes', 'utf8');
  writeFileSync(
    transcriptTextPath,
    [
      '[00:01-00:03] 哈喽 大家好',
      '[08:15-08:21] 这里出现 too many parameters to float constructor',
      '[10:13-10:25] P1 减去 P2 再取 length',
    ].join('\n'),
    'utf8',
  );

  writeJson(join(videoPath, 'qwen-style-video-analysis-bundle.json'), {
    video_id: 'BV_TEST',
    source_url: 'https://www.bilibili.com/video/BV_TEST/',
    platform_title: '平台标题不准确',
    computed_title: 'HLSL入门教程：在虚幻引擎中调用函数计算距离和长度',
    uploader: '月龙千叶',
    duration_seconds: 684.6,
    signal_profile: {
      content_type: 'screen_recording_tutorial',
      primary_signal: 'visual',
      hard_subtitle: true,
      screen_recording: true,
      code_or_formula: true,
      audio_value: 'low',
    },
    timeline_segments: [
      {
        start: '07:30',
        end: '09:00',
        topic: '参数调整与错误排查',
        summary: '演示 float/float2/float3 类型不匹配导致的编译错误。',
        knowledge_value: 'high',
      },
    ],
    operation_notes: [
      {
        title: '排查 float/float2/float3 类型不匹配',
        purpose: '识别 HLSL/Niagara 中常见的参数数量和向量维度错误。',
        steps: ['看到编译错误后先检查构造函数参数数量。', '如果需要三维向量，改用 float3。'],
        evidence_ranges: ['07:30-08:45'],
        visual_terms: ['too many parameters to float constructor', 'float', 'float3'],
        confidence: 'high',
        needs_exact_review: false,
      },
    ],
    key_screenshots: [
      {
        time: '08:15',
        title: 'float 构造函数报错',
        path: join(videoPath, 'evidence_screenshots', 'shot-000815.png'),
        why: '编译错误截图。',
      },
    ],
  });

  writeJson(join(videoPath, 'hard-subtitle-operation-notes.safe.json'), {
    video_id: 'BV_TEST',
    computed_title: 'HLSL入门教程：在虚幻引擎中调用函数计算距离和长度',
    operation_notes: [
      {
        title: '在 Niagara 中计算两点距离',
        purpose: '计算两个点或两个向量之间的距离。',
        steps: ['准备 P1 和 P2。', '用 length(P1 - P2) 得到距离。'],
        evidence_ranges: ['04:30-06:00'],
        visual_terms: ['P1', 'P2', 'length', 'float3'],
        confidence: 'high',
        needs_exact_review: true,
      },
    ],
    agent_usage: {
      can_answer_how_to: true,
      safe_to_quote_exact_code: false,
    },
  });
  writeFileSync(join(videoPath, 'video-report.md'), '# HLSL 视频报告\n', 'utf8');
  writeFileSync(join(videoPath, 'video-evidence.md'), '# HLSL 证据文档\n', 'utf8');
  writeJson(keyframeManifestPath, {
    strategy: 'hybrid',
    algorithm: 'hybrid_visual_cluster_plus_timeline_coverage_and_semantic_scoring',
    selectedCount: 17,
    semanticSignalCount: 91,
    semanticMinScore: 0.8,
    semanticWindowSeconds: 10,
    maxFramesPerMinute: 3,
    diffThreshold: 0.08,
  });
  writeJson(join(videoPath, 'video-document-manifest.json'), {
    videoId: 'BV_TEST',
    documentType: 'video_report',
    reportPath: join(videoPath, 'video-report.md'),
    evidencePath: join(videoPath, 'video-evidence.md'),
    transcriptTextPath,
    assetsDirectory: join(videoPath, 'document-assets'),
    keyframeSelection: {
      source: 'keyframe_manifest',
      manifestPath: keyframeManifestPath,
      strategy: 'hybrid',
      algorithm: 'hybrid_visual_cluster_plus_timeline_coverage_and_semantic_scoring',
      selectedCount: 17,
      usableScreenshots: 17,
    },
    boundary: {
      scope: 'video_report_only',
      outputOnly: true,
    },
  });

  return rootPath;
}

function createPartialVideoRoot(): string {
  const rootPath = mkdtempSync(join(tmpdir(), 'video-knowledge-partial-'));
  const videoPath = join(rootPath, 'BV_PARTIAL');

  mkdirSync(join(videoPath, 'asr'), { recursive: true });
  mkdirSync(join(videoPath, 'evidence_screenshots'), { recursive: true });
  writeFileSync(join(videoPath, 'asr', 'transcript.txt'), '[00:01-00:05] 只有转录，还没有报告\n', 'utf8');
  writeFileSync(join(videoPath, 'evidence_screenshots', 'shot-000001.png'), 'fake image bytes', 'utf8');

  return rootPath;
}

function createDocumentedBilibiliVideo(rootPath: string, videoId: string, title = videoId): string {
  const videoPath = join(rootPath, videoId);

  mkdirSync(join(videoPath, 'document-assets'), { recursive: true });
  writeJson(join(videoPath, 'source.info.json'), {
    platform: 'bilibili',
    platform_title: title,
    source_url: `https://www.bilibili.com/video/${videoId}/`,
  });
  writeFileSync(join(videoPath, 'video-report.md'), `# ${title}\n`, 'utf8');
  writeFileSync(join(videoPath, 'video-evidence.md'), `# ${title} 证据\n`, 'utf8');
  writeJson(join(videoPath, 'video-document-manifest.json'), {
    videoId,
    reportPath: join(videoPath, 'video-report.md'),
    evidencePath: join(videoPath, 'video-evidence.md'),
    assetsDirectory: join(videoPath, 'document-assets'),
  });

  return videoPath;
}

function createVideoConnector(rootPath: string, extraConfig: Record<string, unknown> = {}): ConnectorRuntime {
  return {
    connectorId: 'runtime.video-knowledge.main',
    connectorType: 'runtime',
    enabled: true,
    status: 'ready',
    title: 'Video Knowledge Store',
    config: { rootPath, ...extraConfig },
  };
}

function createBilibiliConnector(rootPath: string, extraConfig: Record<string, unknown> = {}): ConnectorRuntime {
  return {
    ...createVideoConnector(rootPath),
    config: {
      rootPath,
      bilibiliCookie: 'SESSDATA=fake-session; bili_jct=fake-csrf',
      ...extraConfig,
    },
  };
}

function createRegistry(): CapabilityRegistry {
  return new CapabilityRegistry({ plugins: loadPlugins() });
}

describe('video knowledge plugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('registers read-only handlers for Hermes video knowledge access', () => {
    const registry = createRegistry();

    expect(registry.get('video.knowledge.search')).toMatchObject({
      category: 'read',
      sideEffectLevel: 'none',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.get('video.knowledge.get')).toMatchObject({
      category: 'read',
      sideEffectLevel: 'none',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.get('video.knowledge.check')).toMatchObject({
      category: 'read',
      sideEffectLevel: 'none',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.getHandler('video.knowledge.search')).toBeTypeOf('function');
    expect(registry.getHandler('video.knowledge.get')).toBeTypeOf('function');
    expect(registry.getHandler('video.knowledge.check')).toBeTypeOf('function');
  });

  it('registers an environment preflight check for video ingestion', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-environment-check-'));
    const registry = createRegistry();

    expect(registry.get('video.environment.check')).toMatchObject({
      category: 'read',
      sideEffectLevel: 'none',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });

    const handler = registry.getHandler('video.environment.check');
    const result = await handler!({
      scope: 'capture',
      strict: 'true',
    }, {
      connector: createVideoConnector(rootPath, {
        ytDlpPath: join(rootPath, 'missing-yt-dlp'),
        ffprobePath: join(rootPath, 'missing-ffprobe'),
        ffmpegPath: join(rootPath, 'missing-ffmpeg'),
      }),
      now: () => '2026-05-03T09:00:00.000Z',
    });

    expect(result).toMatchObject({
      resultType: 'resource',
      resourceRef: 'resource.video_environment',
      data: {
        ok: false,
        status: 'blocked',
        scope: 'capture',
        strict: true,
        missing: expect.arrayContaining(['yt-dlp', 'ffprobe', 'ffmpeg']),
        problemCodes: expect.arrayContaining(['missing_binary']),
      },
    });
  });

  it('fails strict environment checks when ffmpeg resolves to a transient temp path', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-environment-temp-'));
    const transientFfmpegPath = join(rootPath, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

    writeFileSync(transientFfmpegPath, '', 'utf8');

    const registry = createRegistry();
    const handler = registry.getHandler('video.environment.check');
    const result = await handler!({
      scope: 'capture',
      strict: 'true',
      download: 'false',
      probe: 'false',
      keyframes: 'true',
    }, {
      connector: createVideoConnector(rootPath, {
        ffmpegPath: transientFfmpegPath,
      }),
      now: () => '2026-05-03T09:05:00.000Z',
    });

    expect(result.data).toMatchObject({
      ok: false,
      status: 'blocked',
      missing: ['ffmpeg'],
      problemCodes: ['unstable_binary_path'],
      checks: [
        {
          name: 'ffmpeg',
          ok: false,
          path: transientFfmpegPath,
          code: 'unstable_binary_path',
        },
      ],
    });
  });

  it('registers a Bilibili favorites sync command for agent use', () => {
    const registry = createRegistry();

    expect(registry.get('bilibili.favorites.sync')).toMatchObject({
      category: 'command',
      sideEffectLevel: 'reversible',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.getHandler('bilibili.favorites.sync')).toBeTypeOf('function');
  });

  it('registers read-only Bilibili favorites list and search tools for agent use', () => {
    const registry = createRegistry();

    expect(registry.get('bilibili.favorites.folders')).toMatchObject({
      category: 'read',
      sideEffectLevel: 'none',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.get('bilibili.favorites.list')).toMatchObject({
      category: 'read',
      sideEffectLevel: 'none',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.get('bilibili.favorites.search')).toMatchObject({
      category: 'read',
      sideEffectLevel: 'none',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.get('bilibili.favorites.orphans')).toMatchObject({
      category: 'read',
      sideEffectLevel: 'none',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.getHandler('bilibili.favorites.folders')).toBeTypeOf('function');
    expect(registry.getHandler('bilibili.favorites.list')).toBeTypeOf('function');
    expect(registry.getHandler('bilibili.favorites.search')).toBeTypeOf('function');
    expect(registry.getHandler('bilibili.favorites.orphans')).toBeTypeOf('function');
  });

  it('registers a video ingest enqueue command for agent use', () => {
    const registry = createRegistry();

    expect(registry.get('video.ingest.enqueue')).toMatchObject({
      category: 'command',
      sideEffectLevel: 'reversible',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.getHandler('video.ingest.enqueue')).toBeTypeOf('function');
  });

  it('registers a video ingest process-next command for agent use', () => {
    const registry = createRegistry();

    expect(registry.get('video.ingest.process-next')).toMatchObject({
      category: 'command',
      sideEffectLevel: 'reversible',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.getHandler('video.ingest.process-next')).toBeTypeOf('function');
  });

  it('registers a video ingest local capture command for agent use', () => {
    const registry = createRegistry();

    expect(registry.get('video.ingest.capture-local')).toMatchObject({
      category: 'command',
      sideEffectLevel: 'reversible',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.getHandler('video.ingest.capture-local')).toBeTypeOf('function');
  });

  it('registers a video ingest local transcription command for agent use', () => {
    const registry = createRegistry();

    expect(registry.get('video.ingest.transcribe-local')).toMatchObject({
      category: 'command',
      sideEffectLevel: 'reversible',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.getHandler('video.ingest.transcribe-local')).toBeTypeOf('function');
  });

  it('registers a video ingest visual analysis command for agent use', () => {
    const registry = createRegistry();

    expect(registry.get('video.ingest.analyze-visual')).toMatchObject({
      category: 'command',
      sideEffectLevel: 'reversible',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.getHandler('video.ingest.analyze-visual')).toBeTypeOf('function');
  });

  it('registers a video ingest bundle composition command for agent use', () => {
    const registry = createRegistry();

    expect(registry.get('video.ingest.compose-bundle')).toMatchObject({
      category: 'command',
      sideEffectLevel: 'reversible',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.getHandler('video.ingest.compose-bundle')).toBeTypeOf('function');
  });

  it('registers a video ingest document composition command for agent use', () => {
    const registry = createRegistry();

    expect(registry.get('video.ingest.compose-document')).toMatchObject({
      category: 'command',
      sideEffectLevel: 'reversible',
      exposure: 'auto',
      connectorId: 'runtime.video-knowledge.main',
    });
    expect(registry.getHandler('video.ingest.compose-document')).toBeTypeOf('function');
  });

  it('enqueues a Bilibili favorite video with local metadata and dedupes repeat requests', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-queue-'));
    const collectionsPath = join(rootPath, '_collections');
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');

    mkdirSync(collectionsPath, { recursive: true });
    writeJson(join(collectionsPath, 'bilibili-favorites.json'), {
      platform: 'bilibili',
      syncedAt: '2026-04-21T04:45:24.522Z',
      folders: [],
      videos: [
        {
          platform: 'bilibili',
          folderId: '3922005994',
          folderTitle: 'Niagara/Shader VFX',
          bvid: 'BV1HLSL1abc2',
          url: 'https://www.bilibili.com/video/BV1HLSL1abc2/',
          title: 'HLSL FlowMap 教程',
          author: '一张显卡',
          duration: 1015,
          ingestStatus: 'pending',
          knowledgeVideoId: 'BV1HLSL1abc2',
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.enqueue');
    const context = {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:00:00.000Z',
    };
    const first = await handler!({
      videoId: 'BV1HLSL1abc2',
      priority: 'high',
      reason: 'HLSL test batch',
    }, context);
    const second = await handler!({
      url: 'https://www.bilibili.com/video/BV1HLSL1abc2/',
      priority: 'normal',
      reason: 'duplicate request',
    }, context);

    expect(first.resultType).toBe('resource');
    expect(first.resourceRef).toBe('resource.video_ingest_queue');
    expect(first.data).toMatchObject({
      queuePath,
      enqueued: true,
      deduped: false,
      metadataOnly: true,
      contentEvidence: false,
      job: {
        jobId: 'bilibili:BV1HLSL1abc2',
        status: 'queued',
        platform: 'bilibili',
        videoId: 'BV1HLSL1abc2',
        sourceUrl: 'https://www.bilibili.com/video/BV1HLSL1abc2/',
        title: 'HLSL FlowMap 教程',
        priority: 'high',
        reason: 'HLSL test batch',
        queuedAt: '2026-04-21T12:00:00.000Z',
        sourceMetadata: {
          folderId: '3922005994',
          folderTitle: 'Niagara/Shader VFX',
          author: '一张显卡',
          duration: 1015,
        },
      },
      processingState: {
        status: 'queued',
        started: false,
        guidance: expect.stringContaining('Do not say it is processing in the background'),
      },
      stats: {
        queued: 1,
        total: 1,
      },
    });
    expect(second.data).toMatchObject({
      queuePath,
      enqueued: false,
      deduped: true,
      job: {
        jobId: 'bilibili:BV1HLSL1abc2',
        priority: 'high',
        reason: 'HLSL test batch',
      },
      stats: {
        queued: 1,
        total: 1,
      },
    });

    const saved = JSON.parse(readFileSync(queuePath, 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({
      version: 1,
      updatedAt: '2026-04-21T12:00:00.000Z',
      jobs: [
        {
          jobId: 'bilibili:BV1HLSL1abc2',
          videoId: 'BV1HLSL1abc2',
          title: 'HLSL FlowMap 教程',
        },
      ],
    });
    expect((saved.jobs as unknown[])).toHaveLength(1);
  });

  it('enqueues a direct Bilibili URL when the video is absent from favorites', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-url-'));
    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.enqueue');
    const result = await handler!({
      url: 'https://www.bilibili.com/video/BV1DIRECTabc/',
      title: 'Direct queue title',
    }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:00:00.000Z',
    });

    expect(result.data).toMatchObject({
      enqueued: true,
      deduped: false,
      job: {
        jobId: 'bilibili:BV1DIRECTabc',
        videoId: 'BV1DIRECTabc',
        sourceUrl: 'https://www.bilibili.com/video/BV1DIRECTabc/',
        title: 'Direct queue title',
        sourceMetadata: {},
      },
    });
  });

  it('returns an empty process-next result when the ingestion queue has no queued jobs', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-empty-'));
    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.process-next');
    const result = await handler!({}, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:10:00.000Z',
    });

    expect(result.resultType).toBe('resource');
    expect(result.resourceRef).toBe('resource.video_ingest_queue');
    expect(result.data).toMatchObject({
      outcome: 'empty_queue',
      selected: false,
      metadataOnly: true,
      contentEvidence: false,
      stats: {
        queued: 0,
        prepared: 0,
        done: 0,
        failed: 0,
        total: 0,
      },
    });
  });

  it('prepares the next high-priority queued video for the compiler pipeline', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-process-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const highWorkDir = join(rootPath, 'BV_HIGH');
    const highSourceInfoPath = join(highWorkDir, 'source.info.json');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_NORMAL',
          status: 'queued',
          platform: 'bilibili',
          videoId: 'BV_NORMAL',
          sourceUrl: 'https://www.bilibili.com/video/BV_NORMAL/',
          title: 'Normal priority',
          priority: 'normal',
          queuedAt: '2026-04-21T11:00:00.000Z',
          sourceMetadata: {},
          metadataOnly: true,
          contentEvidence: false,
        },
        {
          jobId: 'bilibili:BV_HIGH',
          status: 'queued',
          platform: 'bilibili',
          videoId: 'BV_HIGH',
          sourceUrl: 'https://www.bilibili.com/video/BV_HIGH/',
          title: 'High priority',
          priority: 'high',
          reason: 'Need HLSL answer',
          queuedAt: '2026-04-21T11:05:00.000Z',
          sourceMetadata: {
            folderTitle: 'Shader 收藏',
            author: 'UP主A',
          },
          metadataOnly: true,
          contentEvidence: false,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.process-next');
    const result = await handler!({}, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:10:00.000Z',
    });

    expect(result.resultType).toBe('resource');
    expect(result.resourceRef).toBe('resource.video_ingest_queue');
    expect(result.data).toMatchObject({
      queuePath,
      outcome: 'prepared',
      selected: true,
      workDir: highWorkDir,
      sourceInfoPath: highSourceInfoPath,
      metadataOnly: true,
      contentEvidence: false,
      job: {
        jobId: 'bilibili:BV_HIGH',
        status: 'prepared',
        platform: 'bilibili',
        videoId: 'BV_HIGH',
        title: 'High priority',
        priority: 'high',
        preparedAt: '2026-04-21T12:10:00.000Z',
        workDir: highWorkDir,
        sourceInfoPath: highSourceInfoPath,
      },
      stats: {
        queued: 1,
        prepared: 1,
        done: 0,
        failed: 0,
        total: 2,
      },
    });

    expect(existsSync(highSourceInfoPath)).toBe(true);
    expect(JSON.parse(readFileSync(highSourceInfoPath, 'utf8'))).toMatchObject({
      video_id: 'BV_HIGH',
      source_url: 'https://www.bilibili.com/video/BV_HIGH/',
      platform_title: 'High priority',
      platform: 'bilibili',
      ingest: {
        status: 'prepared',
        jobId: 'bilibili:BV_HIGH',
        reason: 'Need HLSL answer',
        metadataOnly: true,
        contentEvidence: false,
      },
      source_metadata: {
        folderTitle: 'Shader 收藏',
        author: 'UP主A',
      },
    });

    const savedQueue = JSON.parse(readFileSync(queuePath, 'utf8')) as Record<string, unknown>;
    expect(savedQueue).toMatchObject({
      updatedAt: '2026-04-21T12:10:00.000Z',
      jobs: [
        {
          jobId: 'bilibili:BV_NORMAL',
          status: 'queued',
        },
        {
          jobId: 'bilibili:BV_HIGH',
          status: 'prepared',
          preparedAt: '2026-04-21T12:10:00.000Z',
          workDir: highWorkDir,
          sourceInfoPath: highSourceInfoPath,
        },
      ],
    });
  });

  it('runs the full ingest pipeline and only reports processed after final verification', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-full-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_FULL');
    const videoPath = join(workDir, 'video.mp4');
    const probePath = join(workDir, 'probe.json');
    const screenshotPath = join(workDir, 'evidence_screenshots', 'shot-000000.png');
    const transcriptTextPath = join(workDir, 'asr', 'transcript.txt');
    const visualWorkDir = join(workDir, 'keyframe_steps');
    const visualFramePath = join(visualWorkDir, 'frames', 'frame-0000.png');
    const visualSummaryPath = join(visualWorkDir, 'keyframe-steps-summary.json');
    const visualScriptPath = join(rootPath, 'fake-visual-analysis.py');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(join(workDir, 'evidence_screenshots'), { recursive: true });
    mkdirSync(join(workDir, 'asr'), { recursive: true });
    mkdirSync(join(visualWorkDir, 'frames'), { recursive: true });
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(screenshotPath, 'fake screenshot bytes', 'utf8');
    writeFileSync(transcriptTextPath, '[00:00-00:03] 这个插件解决 UE5 编辑器问题\n', 'utf8');
    writeFileSync(visualFramePath, 'fake visual frame bytes', 'utf8');
    writeFileSync(visualScriptPath, '# fake visual analysis script\n', 'utf8');
    writeJson(probePath, {
      format: {
        duration: '12.5',
      },
      streams: [
        {
          codec_type: 'video',
          width: 1280,
          height: 720,
        },
      ],
    });
    writeJson(visualSummaryPath, {
      source_video: videoPath,
      duration_seconds: 12.5,
      mode: 'keyframes',
      results: [
        {
          index: 0,
          segment_range: '00:00-00:12',
          frame_times: ['00:00'],
          frame_paths: [visualFramePath],
          analysis: {
            segment_range: '00:00-00:12',
            signal_profile: {
              has_screen_recording: true,
              primary_signal: 'visual',
              confidence: 'high',
            },
            visible_text: [
              {
                time: '00:00',
                text: 'UE5 Plugin',
                source: 'ui_label',
                confidence: 'high',
              },
            ],
            operation_steps: [
              {
                step_no: 1,
                time: '00:00',
                action: '展示 UE5 插件功能',
                target: 'Unreal Editor',
                observed_result: '界面问题被修复',
                confidence: 'high',
              },
            ],
            concepts: [
              {
                title: 'UE5 插件问题修复',
                summary: '视频展示一个自制 UE5 插件用于解决编辑器问题。',
                evidence: '00:00-00:12',
                confidence: 'high',
              },
            ],
            needs_rewatch: [],
          },
        },
      ],
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_FULL',
          status: 'queued',
          platform: 'bilibili',
          videoId: 'BV_FULL',
          sourceUrl: 'https://www.bilibili.com/video/BV_FULL/',
          title: 'Full pipeline test',
          priority: 'normal',
          queuedAt: '2026-04-21T12:00:00.000Z',
          sourceMetadata: {
            folderTitle: '默认收藏夹',
            author: '测试UP',
            duration: 12.5,
          },
          metadataOnly: true,
          contentEvidence: false,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.process-full');
    const result = await handler!({
      videoId: 'BV_FULL',
      download: 'false',
      probe: 'false',
      keyframes: 'false',
      whisper: 'false',
      scriptPath: visualScriptPath,
      autoKeyframeSelection: 'false',
    }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:40:00.000Z',
    });

    expect(result.resultType).toBe('resource');
    expect(result.resourceRef).toBe('resource.video_ingest_full_pipeline');
    expect(result.data).toMatchObject({
      outcome: 'processed',
      selected: true,
      videoId: 'BV_FULL',
      steps: {
        processNext: { outcome: 'prepared', selected: true },
        captureLocal: { outcome: 'captured', mediaEvidence: true },
        transcribeLocal: { outcome: 'transcribed', transcriptEvidence: true },
        analyzeVisual: { outcome: 'visual_analyzed', visualEvidence: true },
        composeBundle: { outcome: 'composed', contentEvidence: true },
        composeDocument: { outcome: 'documented', documentEvidence: true },
      },
      finalCheck: {
        ok: true,
        status: 'processed',
        paths: {
          reportPath: join(workDir, 'video-report.md'),
          evidencePath: join(workDir, 'video-evidence.md'),
          documentManifestPath: join(workDir, 'video-document-manifest.json'),
          documentAssetsDir: join(workDir, 'document-assets'),
        },
      },
      guidance: expect.stringContaining('Only report completion when finalCheck.ok is true'),
    });

    expect(existsSync(join(workDir, 'video-report.md'))).toBe(true);
    expect(existsSync(join(workDir, 'video-evidence.md'))).toBe(true);
    expect(existsSync(join(workDir, 'video-document-manifest.json'))).toBe(true);
    expect(existsSync(join(workDir, 'document-assets'))).toBe(true);
  });

  it('auto-enqueues a fresh URL when process-full is called with only a video address', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-full-url-'));
    const workDir = join(rootPath, 'BV1AUTO12345');
    const videoPath = join(workDir, 'video.mp4');
    const probePath = join(workDir, 'probe.json');
    const screenshotPath = join(workDir, 'evidence_screenshots', 'shot-000000.png');
    const transcriptTextPath = join(workDir, 'asr', 'transcript.txt');
    const visualWorkDir = join(workDir, 'keyframe_steps');
    const visualFramePath = join(visualWorkDir, 'frames', 'frame-0000.png');
    const visualSummaryPath = join(visualWorkDir, 'keyframe-steps-summary.json');
    const visualScriptPath = join(rootPath, 'fake-visual-analysis.py');

    mkdirSync(join(workDir, 'evidence_screenshots'), { recursive: true });
    mkdirSync(join(workDir, 'asr'), { recursive: true });
    mkdirSync(join(visualWorkDir, 'frames'), { recursive: true });
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(screenshotPath, 'fake screenshot bytes', 'utf8');
    writeFileSync(transcriptTextPath, '[00:00-00:03] 只给 URL 也能完整处理\n', 'utf8');
    writeFileSync(visualFramePath, 'fake visual frame bytes', 'utf8');
    writeFileSync(visualScriptPath, '# fake visual analysis script\n', 'utf8');
    writeJson(probePath, {
      format: {
        duration: '10.0',
      },
      streams: [
        {
          codec_type: 'video',
          width: 1280,
          height: 720,
        },
      ],
    });
    writeJson(visualSummaryPath, {
      source_video: videoPath,
      duration_seconds: 10,
      mode: 'keyframes',
      results: [
        {
          index: 0,
          segment_range: '00:00-00:10',
          frame_times: ['00:00'],
          frame_paths: [visualFramePath],
          analysis: {
            segment_range: '00:00-00:10',
            signal_profile: {
              has_screen_recording: true,
              primary_signal: 'visual',
              confidence: 'high',
            },
            visible_text: [
              {
                time: '00:00',
                text: 'One-shot ingest',
                source: 'ui_label',
                confidence: 'high',
              },
            ],
            operation_steps: [
              {
                step_no: 1,
                time: '00:00',
                action: '用户只给视频 URL，流水线自动入队并生成报告',
                target: 'video pipeline',
                observed_result: '生成正式报告',
                confidence: 'high',
              },
            ],
            concepts: [
              {
                title: '一键视频采集',
                summary: 'process-full 可以从一个新视频地址自动完成入队、处理和报告生成。',
                evidence: '00:00-00:10',
                confidence: 'high',
              },
            ],
            needs_rewatch: [],
          },
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.process-full');
    const result = await handler!({
      url: 'https://www.bilibili.com/video/BV1AUTO12345/',
      download: 'false',
      probe: 'false',
      keyframes: 'false',
      whisper: 'false',
      scriptPath: visualScriptPath,
      autoKeyframeSelection: 'false',
    }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:42:00.000Z',
    });

    expect(result.resultType).toBe('resource');
    expect(result.resourceRef).toBe('resource.video_ingest_full_pipeline');
    expect(result.data).toMatchObject({
      outcome: 'processed',
      selected: true,
      videoId: 'BV1AUTO12345',
      steps: {
        processNext: { outcome: 'empty_queue', selected: false },
        enqueue: { enqueued: true, deduped: false },
        processNextAfterEnqueue: { outcome: 'prepared', selected: true },
        captureLocal: { outcome: 'captured', mediaEvidence: true },
        transcribeLocal: { outcome: 'transcribed', transcriptEvidence: true },
        analyzeVisual: { outcome: 'visual_analyzed', visualEvidence: true },
        composeBundle: { outcome: 'composed', contentEvidence: true },
        composeDocument: { outcome: 'documented', documentEvidence: true },
      },
      finalCheck: {
        ok: true,
        status: 'processed',
        paths: {
          reportPath: join(workDir, 'video-report.md'),
          evidencePath: join(workDir, 'video-evidence.md'),
          documentManifestPath: join(workDir, 'video-document-manifest.json'),
          documentAssetsDir: join(workDir, 'document-assets'),
        },
      },
    });

    expect(existsSync(join(workDir, 'video-report.md'))).toBe(true);
  });

  it('blocks process-full at environment-check before downloading when prerequisites are missing', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-full-env-block-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_ENV_BLOCK');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_ENV_BLOCK',
          status: 'queued',
          platform: 'bilibili',
          videoId: 'BV_ENV_BLOCK',
          sourceUrl: 'https://www.bilibili.com/video/BV_ENV_BLOCK/',
          title: 'Environment block test',
          priority: 'normal',
          queuedAt: '2026-05-03T09:00:00.000Z',
          metadataOnly: true,
          contentEvidence: false,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.process-full');
    const result = await handler!({
      videoId: 'BV_ENV_BLOCK',
    }, {
      connector: createVideoConnector(rootPath, {
        ytDlpPath: join(rootPath, 'missing-yt-dlp'),
        ffprobePath: join(rootPath, 'missing-ffprobe'),
        ffmpegPath: join(rootPath, 'missing-ffmpeg'),
      }),
      now: () => '2026-05-03T09:01:00.000Z',
    });

    expect(result.data).toMatchObject({
      outcome: 'blocked',
      selected: true,
      videoId: 'BV_ENV_BLOCK',
      blockedAt: 'environment-check',
      reason: 'missing_binary',
      steps: {
        processNext: { outcome: 'prepared', selected: true },
        environmentCheck: {
          ok: false,
          status: 'blocked',
          scope: 'process-full',
          strict: true,
          missing: expect.arrayContaining(['yt-dlp', 'ffprobe', 'ffmpeg']),
          plan: {
            videoId: 'BV_ENV_BLOCK',
            workDir,
            hasVideo: false,
            hasProbe: false,
            hasScreenshots: false,
          },
        },
      },
      finalCheck: {
        ok: false,
        status: 'in_progress',
      },
    });
    expect(existsSync(join(workDir, 'video.mp4'))).toBe(false);
    expect(existsSync(join(workDir, 'local-capture-manifest.json'))).toBe(false);
  });

  it('continues the full ingest pipeline for a prepared target when no queued jobs remain', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-full-prepared-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_FULL_PREPARED');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const videoPath = join(workDir, 'video.mp4');
    const probePath = join(workDir, 'probe.json');
    const screenshotPath = join(workDir, 'evidence_screenshots', 'shot-000000.png');
    const transcriptTextPath = join(workDir, 'asr', 'transcript.txt');
    const visualWorkDir = join(workDir, 'keyframe_steps');
    const visualFramePath = join(visualWorkDir, 'frames', 'frame-0000.png');
    const visualSummaryPath = join(visualWorkDir, 'keyframe-steps-summary.json');
    const visualScriptPath = join(rootPath, 'fake-visual-analysis.py');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(join(workDir, 'evidence_screenshots'), { recursive: true });
    mkdirSync(join(workDir, 'asr'), { recursive: true });
    mkdirSync(join(visualWorkDir, 'frames'), { recursive: true });
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(screenshotPath, 'fake screenshot bytes', 'utf8');
    writeFileSync(transcriptTextPath, '[00:00-00:03] 已准备好的视频继续处理\n', 'utf8');
    writeFileSync(visualFramePath, 'fake visual frame bytes', 'utf8');
    writeFileSync(visualScriptPath, '# fake visual analysis script\n', 'utf8');
    writeJson(probePath, {
      format: {
        duration: '8.0',
      },
      streams: [
        {
          codec_type: 'video',
          width: 1280,
          height: 720,
        },
      ],
    });
    writeJson(visualSummaryPath, {
      source_video: videoPath,
      duration_seconds: 8,
      mode: 'keyframes',
      results: [
        {
          index: 0,
          segment_range: '00:00-00:08',
          frame_times: ['00:00'],
          frame_paths: [visualFramePath],
          analysis: {
            segment_range: '00:00-00:08',
            signal_profile: {
              has_screen_recording: true,
              primary_signal: 'visual',
              confidence: 'high',
            },
            visible_text: [
              {
                time: '00:00',
                text: 'Prepared resume',
                source: 'ui_label',
                confidence: 'high',
              },
            ],
            operation_steps: [
              {
                step_no: 1,
                time: '00:00',
                action: '从 prepared 状态续跑全流程',
                target: 'video pipeline',
                observed_result: '生成正式报告',
                confidence: 'high',
              },
            ],
            concepts: [
              {
                title: '续跑 prepared 视频',
                summary: '视频已完成调度准备时，完整流水线应继续后续步骤。',
                evidence: '00:00-00:08',
                confidence: 'high',
              },
            ],
            needs_rewatch: [],
          },
        },
      ],
    });
    writeJson(sourceInfoPath, {
      video_id: 'BV_FULL_PREPARED',
      source_url: 'https://www.bilibili.com/video/BV_FULL_PREPARED/',
      platform: 'bilibili',
      platform_title: 'Prepared full pipeline test',
      ingest: {
        status: 'prepared',
        jobId: 'bilibili:BV_FULL_PREPARED',
        workDir,
        sourceInfoPath,
        metadataOnly: true,
        contentEvidence: false,
      },
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_FULL_PREPARED',
          status: 'prepared',
          platform: 'bilibili',
          videoId: 'BV_FULL_PREPARED',
          sourceUrl: 'https://www.bilibili.com/video/BV_FULL_PREPARED/',
          title: 'Prepared full pipeline test',
          priority: 'normal',
          queuedAt: '2026-04-21T12:00:00.000Z',
          preparedAt: '2026-04-21T12:05:00.000Z',
          workDir,
          sourceInfoPath,
          sourceMetadata: {},
          metadataOnly: true,
          contentEvidence: false,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.process-full');
    const result = await handler!({
      videoId: 'BV_FULL_PREPARED',
      download: 'false',
      probe: 'false',
      keyframes: 'false',
      whisper: 'false',
      scriptPath: visualScriptPath,
      autoKeyframeSelection: 'false',
    }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:45:00.000Z',
    });

    expect(result.resultType).toBe('resource');
    expect(result.resourceRef).toBe('resource.video_ingest_full_pipeline');
    expect(result.data).toMatchObject({
      outcome: 'processed',
      selected: true,
      videoId: 'BV_FULL_PREPARED',
      steps: {
        processNext: { outcome: 'empty_queue', selected: false },
        captureLocal: { outcome: 'captured', mediaEvidence: true },
        transcribeLocal: { outcome: 'transcribed', transcriptEvidence: true },
        analyzeVisual: { outcome: 'visual_analyzed', visualEvidence: true },
        composeBundle: { outcome: 'composed', contentEvidence: true },
        composeDocument: { outcome: 'documented', documentEvidence: true },
      },
      finalCheck: {
        ok: true,
        status: 'processed',
        paths: {
          reportPath: join(workDir, 'video-report.md'),
          evidencePath: join(workDir, 'video-evidence.md'),
          documentManifestPath: join(workDir, 'video-document-manifest.json'),
          documentAssetsDir: join(workDir, 'document-assets'),
        },
      },
    });

    expect(existsSync(join(workDir, 'video-report.md'))).toBe(true);
  });

  it('resumes the full ingest pipeline from an already transcribed target', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-full-transcribed-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV1RESUME123');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const videoPath = join(workDir, 'video.mp4');
    const probePath = join(workDir, 'probe.json');
    const screenshotDirectory = join(workDir, 'evidence_screenshots');
    const screenshotPath = join(screenshotDirectory, 'shot-000000.png');
    const transcriptTextPath = join(workDir, 'asr', 'transcript.txt');
    const visualWorkDir = join(workDir, 'keyframe_steps');
    const visualFramePath = join(visualWorkDir, 'frames', 'frame-0000.png');
    const visualSummaryPath = join(visualWorkDir, 'keyframe-steps-summary.json');
    const visualScriptPath = join(rootPath, 'fake-visual-analysis.py');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(screenshotDirectory, { recursive: true });
    mkdirSync(join(workDir, 'asr'), { recursive: true });
    mkdirSync(join(visualWorkDir, 'frames'), { recursive: true });
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(screenshotPath, 'fake screenshot bytes', 'utf8');
    writeFileSync(transcriptTextPath, '[00:00-00:03] 已转写的视频继续生成报告\n', 'utf8');
    writeFileSync(visualFramePath, 'fake visual frame bytes', 'utf8');
    writeFileSync(visualScriptPath, '# fake visual analysis script\n', 'utf8');
    writeJson(probePath, {
      format: {
        duration: '9.0',
      },
      streams: [
        {
          codec_type: 'video',
          width: 1280,
          height: 720,
        },
      ],
    });
    writeJson(visualSummaryPath, {
      source_video: videoPath,
      duration_seconds: 9,
      mode: 'keyframes',
      results: [
        {
          index: 0,
          segment_range: '00:00-00:09',
          frame_times: ['00:00'],
          frame_paths: [visualFramePath],
          analysis: {
            segment_range: '00:00-00:09',
            signal_profile: {
              has_screen_recording: true,
              primary_signal: 'visual',
              confidence: 'high',
            },
            visible_text: [
              {
                time: '00:00',
                text: 'Resume from transcript',
                source: 'ui_label',
                confidence: 'high',
              },
            ],
            operation_steps: [
              {
                step_no: 1,
                time: '00:00',
                action: '从已转写状态继续视觉分析和文档生成',
                target: 'video pipeline',
                observed_result: '生成正式报告',
                confidence: 'high',
              },
            ],
            concepts: [
              {
                title: '中间态续跑',
                summary: 'process-full 应能从 transcribed 状态继续后续阶段。',
                evidence: '00:00-00:09',
                confidence: 'high',
              },
            ],
            needs_rewatch: [],
          },
        },
      ],
    });
    writeJson(sourceInfoPath, {
      video_id: 'BV1RESUME123',
      source_url: 'https://www.bilibili.com/video/BV1RESUME123/',
      platform: 'bilibili',
      platform_title: 'Transcribed resume test',
      ingest: {
        status: 'transcribed',
        jobId: 'bilibili:BV1RESUME123',
        workDir,
        sourceInfoPath,
        videoPath,
        probePath,
        screenshotDirectory,
        transcriptTextPath,
        metadataOnly: false,
        contentEvidence: false,
      },
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV1RESUME123',
          status: 'transcribed',
          platform: 'bilibili',
          videoId: 'BV1RESUME123',
          sourceUrl: 'https://www.bilibili.com/video/BV1RESUME123/',
          title: 'Transcribed resume test',
          priority: 'normal',
          queuedAt: '2026-04-21T12:00:00.000Z',
          preparedAt: '2026-04-21T12:05:00.000Z',
          capturedAt: '2026-04-21T12:06:00.000Z',
          transcribedAt: '2026-04-21T12:07:00.000Z',
          workDir,
          sourceInfoPath,
          videoPath,
          probePath,
          screenshotDirectory,
          transcriptTextPath,
          sourceMetadata: {},
          mediaEvidence: true,
          transcriptEvidence: true,
          metadataOnly: false,
          contentEvidence: false,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.process-full');
    const result = await handler!({
      videoId: 'BV1RESUME123',
      download: 'false',
      probe: 'false',
      keyframes: 'false',
      whisper: 'false',
      scriptPath: visualScriptPath,
      autoKeyframeSelection: 'false',
    }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:46:00.000Z',
    });

    expect(result.data).toMatchObject({
      outcome: 'processed',
      selected: true,
      videoId: 'BV1RESUME123',
      steps: {
        processNext: { outcome: 'empty_queue', selected: false },
        enqueue: { enqueued: false, deduped: true },
        captureLocal: { outcome: 'captured', mediaEvidence: true },
        transcribeLocal: { outcome: 'transcribed', transcriptEvidence: true },
        analyzeVisual: { outcome: 'visual_analyzed', visualEvidence: true },
        composeBundle: { outcome: 'composed', contentEvidence: true },
        composeDocument: { outcome: 'documented', documentEvidence: true },
      },
      finalCheck: {
        ok: true,
        status: 'processed',
      },
    });

    expect(existsSync(join(workDir, 'video-report.md'))).toBe(true);
  });

  it('blocks capture before writing yt-dlp cookies when download prerequisites are missing', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-cookie-download-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_COOKIE');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const cookieFilePath = join(rootPath, 'secrets', 'bilibili.cookie.txt');
    const missingYtDlpPath = join(rootPath, 'missing-yt-dlp');
    const generatedCookieJarPath = join(workDir, 'bilibili.yt-dlp.cookies.txt');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(join(rootPath, 'secrets'), { recursive: true });
    writeFileSync(
      cookieFilePath,
      'SESSDATA=session-secret; bili_jct=csrf-secret; DedeUserID=42\n',
      'utf8',
    );
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_COOKIE',
          status: 'prepared',
          platform: 'bilibili',
          videoId: 'BV_COOKIE',
          sourceUrl: 'https://www.bilibili.com/video/BV_COOKIE/',
          title: 'Cookie download test',
          priority: 'normal',
          queuedAt: '2026-04-21T12:00:00.000Z',
          preparedAt: '2026-04-21T12:05:00.000Z',
          workDir,
          sourceInfoPath,
          metadataOnly: true,
          contentEvidence: false,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.capture-local');
    let thrown: unknown;

    try {
      await handler!({ videoId: 'BV_COOKIE' }, {
        connector: createVideoConnector(rootPath, {
          bilibiliCookieFilePath: cookieFilePath,
          ytDlpPath: missingYtDlpPath,
        }),
        now: () => '2026-04-21T12:50:00.000Z',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const json = (thrown as { toJSON?: () => { details?: Record<string, unknown> } }).toJSON?.();
    const environment = json?.details?.environment as Record<string, unknown> | undefined;

    expect(json).toMatchObject({
      code: 'connector_unavailable',
      details: {
        stage: 'capture-local',
      },
    });
    expect(environment).toMatchObject({
      ok: false,
      status: 'blocked',
      scope: 'capture-local',
      missing: expect.arrayContaining(['yt-dlp']),
    });
    expect(JSON.stringify(json)).not.toContain('session-secret');
    expect(JSON.stringify(json)).not.toContain('csrf-secret');
    expect(existsSync(generatedCookieJarPath)).toBe(false);
  });

  it('normalizes Netscape Bilibili cookie files before API use', () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-netscape-cookie-'));
    const cookieFilePath = join(rootPath, 'secrets', 'bilibili.cookie.txt');

    mkdirSync(join(rootPath, 'secrets'), { recursive: true });
    writeFileSync(
      cookieFilePath,
      [
        '# Netscape HTTP Cookie File',
        '.bilibili.com\tTRUE\t/\tTRUE\t0\tDedeUserID\t42',
        '.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tsession-secret',
        '.bilibili.com\tTRUE\t/\tFALSE\t0\tbili_jct\tcsrf-secret',
      ].join('\n'),
      'utf8',
    );

    const cookie = getBilibiliCookie(createVideoConnector(rootPath, {
      bilibiliCookieFilePath: cookieFilePath,
    }));

    expect(cookie?.cookie).toBe('SESSDATA=session-secret; bili_jct=csrf-secret; DedeUserID=42');
  });

  it('captures existing local media evidence for a prepared video without marking content as analyzed', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-capture-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_CAPTURE');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const manifestPath = join(workDir, 'local-capture-manifest.json');
    const probePath = join(workDir, 'probe.json');
    const videoPath = join(workDir, 'video.mp4');
    const screenshotPath = join(workDir, 'evidence_screenshots', 'shot-000000.png');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(join(workDir, 'evidence_screenshots'), { recursive: true });
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(screenshotPath, 'fake screenshot bytes', 'utf8');
    writeJson(probePath, {
      format: {
        duration: '12.5',
      },
      streams: [
        {
          codec_type: 'video',
          width: 1280,
          height: 720,
        },
      ],
    });
    writeJson(sourceInfoPath, {
      video_id: 'BV_CAPTURE',
      source_url: 'https://www.bilibili.com/video/BV_CAPTURE/',
      platform_title: 'Prepared capture title',
      ingest: {
        status: 'prepared',
        contentEvidence: false,
      },
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_CAPTURE',
          status: 'prepared',
          platform: 'bilibili',
          videoId: 'BV_CAPTURE',
          sourceUrl: 'https://www.bilibili.com/video/BV_CAPTURE/',
          title: 'Prepared capture title',
          priority: 'high',
          preparedAt: '2026-04-21T12:10:00.000Z',
          workDir,
          sourceInfoPath,
          metadataOnly: true,
          contentEvidence: false,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.capture-local');
    const result = await handler!({ videoId: 'BV_CAPTURE' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:20:00.000Z',
    });

    expect(result.resultType).toBe('resource');
    expect(result.resourceRef).toBe('resource.video_ingest_queue');
    expect(result.data).toMatchObject({
      outcome: 'captured',
      selected: true,
      workDir,
      manifestPath,
      videoPath,
      probePath,
      mediaEvidence: true,
      contentEvidence: false,
      job: {
        jobId: 'bilibili:BV_CAPTURE',
        status: 'captured',
        mediaEvidence: true,
        contentEvidence: false,
        capturedAt: '2026-04-21T12:20:00.000Z',
      },
      stats: {
        queued: 0,
        prepared: 0,
        captured: 1,
        done: 0,
        failed: 0,
        total: 1,
      },
    });

    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
      videoId: 'BV_CAPTURE',
      sourceUrl: 'https://www.bilibili.com/video/BV_CAPTURE/',
      videoPath,
      probePath,
      screenshotDirectory: join(workDir, 'evidence_screenshots'),
      screenshots: [
        {
          path: screenshotPath,
        },
      ],
      mediaEvidence: true,
      contentEvidence: false,
      steps: {
        download: {
          skipped: true,
          reason: 'video_exists',
        },
        probe: {
          skipped: true,
          reason: 'probe_exists',
        },
        keyframes: {
          skipped: true,
          reason: 'screenshots_exist',
        },
      },
    });
    expect(JSON.parse(readFileSync(sourceInfoPath, 'utf8'))).toMatchObject({
      ingest: {
        status: 'captured',
        localCaptureAt: '2026-04-21T12:20:00.000Z',
        localCaptureManifestPath: manifestPath,
        mediaEvidence: true,
        contentEvidence: false,
      },
    });
  });

  it('indexes existing ASR transcript files for a captured video without marking semantic content as analyzed', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-transcribe-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_ASR');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const transcriptManifestPath = join(workDir, 'asr', 'transcript-manifest.json');
    const transcriptTextPath = join(workDir, 'asr', 'transcript.txt');
    const transcriptJsonPath = join(workDir, 'asr', 'transcript.json');
    const transcriptSrtPath = join(workDir, 'asr', 'transcript.srt');
    const videoPath = join(workDir, 'video.mp4');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(join(workDir, 'asr'), { recursive: true });
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(transcriptTextPath, '[00:00-00:02] 大家好\n[00:02-00:05] 这里演示 FlowMap\n', 'utf8');
    writeJson(transcriptJsonPath, {
      segments: [
        {
          start: 0,
          end: 2,
          text: '大家好',
        },
        {
          start: 2,
          end: 5,
          text: '这里演示 FlowMap',
        },
      ],
    });
    writeFileSync(transcriptSrtPath, '1\n00:00:00,000 --> 00:00:02,000\n大家好\n', 'utf8');
    writeJson(sourceInfoPath, {
      video_id: 'BV_ASR',
      source_url: 'https://www.bilibili.com/video/BV_ASR/',
      ingest: {
        status: 'captured',
        mediaEvidence: true,
        contentEvidence: false,
      },
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_ASR',
          status: 'captured',
          platform: 'bilibili',
          videoId: 'BV_ASR',
          sourceUrl: 'https://www.bilibili.com/video/BV_ASR/',
          title: 'Captured ASR title',
          workDir,
          sourceInfoPath,
          videoPath,
          mediaEvidence: true,
          contentEvidence: false,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.transcribe-local');
    const result = await handler!({ videoId: 'BV_ASR' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:30:00.000Z',
    });

    expect(result.resultType).toBe('resource');
    expect(result.resourceRef).toBe('resource.video_ingest_queue');
    expect(result.data).toMatchObject({
      outcome: 'transcribed',
      selected: true,
      workDir,
      transcriptManifestPath,
      transcriptEvidence: true,
      contentEvidence: false,
      transcript: {
        textPath: transcriptTextPath,
        jsonPath: transcriptJsonPath,
        srtPath: transcriptSrtPath,
        preview: [
          '[00:00-00:02] 大家好',
          '[00:02-00:05] 这里演示 FlowMap',
        ],
      },
      job: {
        jobId: 'bilibili:BV_ASR',
        status: 'transcribed',
        transcriptEvidence: true,
        contentEvidence: false,
        transcribedAt: '2026-04-21T12:30:00.000Z',
      },
      stats: {
        queued: 0,
        prepared: 0,
        captured: 0,
        transcribed: 1,
        done: 0,
        failed: 0,
        total: 1,
      },
    });

    expect(JSON.parse(readFileSync(transcriptManifestPath, 'utf8'))).toMatchObject({
      videoId: 'BV_ASR',
      transcribedAt: '2026-04-21T12:30:00.000Z',
      transcriptEvidence: true,
      contentEvidence: false,
      textPath: transcriptTextPath,
      jsonPath: transcriptJsonPath,
      srtPath: transcriptSrtPath,
      preview: [
        '[00:00-00:02] 大家好',
        '[00:02-00:05] 这里演示 FlowMap',
      ],
      steps: {
        apiTranscription: {
          skipped: true,
          reason: 'transcript_exists',
        },
      },
    });
    expect(JSON.parse(readFileSync(sourceInfoPath, 'utf8'))).toMatchObject({
      ingest: {
        status: 'transcribed',
        transcribedAt: '2026-04-21T12:30:00.000Z',
        transcriptManifestPath,
        transcriptEvidence: true,
        contentEvidence: false,
      },
    });
  });

  it('does not promote Gemini error files into canonical transcript evidence', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-asr-error-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_ASR_ERROR');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const transcriptManifestPath = join(workDir, 'asr', 'transcript-manifest.json');
    const transcriptTextPath = join(workDir, 'asr', 'transcript.txt');
    const errorPath = join(workDir, 'asr', 'gemini-transcript-0000-0047.error.txt');
    const videoPath = join(workDir, 'video.mp4');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(join(workDir, 'asr'), { recursive: true });
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(errorPath, 'Traceback (most recent call last):\nhttpx.RemoteProtocolError: Server disconnected\n', 'utf8');
    writeJson(sourceInfoPath, {
      video_id: 'BV_ASR_ERROR',
      source_url: 'https://www.bilibili.com/video/BV_ASR_ERROR/',
      ingest: {
        status: 'captured',
        mediaEvidence: true,
        contentEvidence: false,
      },
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_ASR_ERROR',
          status: 'captured',
          platform: 'bilibili',
          videoId: 'BV_ASR_ERROR',
          sourceUrl: 'https://www.bilibili.com/video/BV_ASR_ERROR/',
          title: 'Captured ASR error title',
          workDir,
          sourceInfoPath,
          videoPath,
          mediaEvidence: true,
          contentEvidence: false,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.transcribe-local');
    const result = await handler!({
      videoId: 'BV_ASR_ERROR',
      provider: 'whisper',
      whisper: 'false',
    }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:31:00.000Z',
    });

    expect(result.data).toMatchObject({
      outcome: 'partial_transcription',
      selected: true,
      transcriptManifestPath,
      transcriptEvidence: false,
      transcript: {
        preview: [],
      },
      job: {
        status: 'captured',
        transcriptEvidence: false,
      },
    });
    expect(existsSync(transcriptTextPath)).toBe(false);
    expect(JSON.parse(readFileSync(transcriptManifestPath, 'utf8'))).toMatchObject({
      transcriptEvidence: false,
      preview: [],
    });
  });

  it('runs a configured API transcription script for a captured video', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-api-transcribe-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_API_ASR');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const transcriptManifestPath = join(workDir, 'asr', 'transcript-manifest.json');
    const transcriptTextPath = join(workDir, 'asr', 'transcript.txt');
    const transcriptJsonPath = join(workDir, 'asr', 'transcript.json');
    const transcriptSrtPath = join(workDir, 'asr', 'transcript.srt');
    const videoPath = join(workDir, 'video.mp4');
    const scriptPath = join(rootPath, 'fake-api-transcribe.cjs');
    const apiKeyFilePath = join(rootPath, 'gemini.key.txt');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(apiKeyFilePath, 'fake-key', 'utf8');
    writeFileSync(scriptPath, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "const get = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };",
      "const asrDir = get('--asr-dir');",
      "fs.mkdirSync(asrDir, { recursive: true });",
      "fs.writeFileSync(path.join(asrDir, 'transcript.txt'), '[00:00-00:03] API 转写成功\\n[00:03-00:06] 这里讲 FlowMap\\n');",
      "fs.writeFileSync(path.join(asrDir, 'transcript.srt'), '1\\n00:00:00,000 --> 00:00:03,000\\nAPI 转写成功\\n');",
      "fs.writeFileSync(path.join(asrDir, 'transcript.json'), JSON.stringify({",
      "  provider: get('--provider'),",
      "  model: get('--model'),",
      "  endpoint: get('--endpoint'),",
      "  apiKeyFilePath: get('--api-key-file'),",
      "  chunks: [{ start: 0, end: 3, text: 'API 转写成功' }]",
      "}, null, 2));",
    ].join('\n'), 'utf8');
    writeJson(sourceInfoPath, {
      video_id: 'BV_API_ASR',
      source_url: 'https://www.bilibili.com/video/BV_API_ASR/',
      ingest: {
        status: 'done',
        mediaEvidence: true,
        contentEvidence: true,
      },
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_API_ASR',
          status: 'done',
          platform: 'bilibili',
          videoId: 'BV_API_ASR',
          sourceUrl: 'https://www.bilibili.com/video/BV_API_ASR/',
          title: 'Captured API ASR title',
          workDir,
          sourceInfoPath,
          videoPath,
          mediaEvidence: true,
          contentEvidence: true,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.transcribe-local');
    const result = await handler!({
      videoId: 'BV_API_ASR',
      provider: 'gemini',
      pythonPath: process.execPath,
      transcriptionScriptPath: scriptPath,
      model: 'gemini-3.1-pro-preview',
      endpoint: 'vertex-express',
      language: 'zh',
      chunkSeconds: '300',
    }, {
      connector: createVideoConnector(rootPath, { visionApiKeyFilePath: apiKeyFilePath }),
      now: () => '2026-04-21T12:35:00.000Z',
    });

    expect(result.resultType).toBe('resource');
    expect(result.resourceRef).toBe('resource.video_ingest_queue');
    expect(result.data).toMatchObject({
      outcome: 'transcribed',
      selected: true,
      workDir,
      transcriptManifestPath,
      transcriptProvider: 'gemini',
      transcriptEvidence: true,
      contentEvidence: true,
      transcript: {
        textPath: transcriptTextPath,
        jsonPath: transcriptJsonPath,
        srtPath: transcriptSrtPath,
        preview: [
          '[00:00-00:03] API 转写成功',
          '[00:03-00:06] 这里讲 FlowMap',
        ],
      },
      job: {
        status: 'done',
        transcriptProvider: 'gemini',
        transcriptEvidence: true,
        contentEvidence: true,
      },
    });
    expect(JSON.parse(readFileSync(transcriptManifestPath, 'utf8'))).toMatchObject({
      transcriptProvider: 'gemini',
      transcriptEvidence: true,
      steps: {
        apiTranscription: {
          skipped: false,
        },
      },
    });
    expect(JSON.parse(readFileSync(transcriptJsonPath, 'utf8'))).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.1-pro-preview',
      endpoint: 'vertex-express',
      apiKeyFilePath,
    });
    expect(JSON.parse(readFileSync(sourceInfoPath, 'utf8'))).toMatchObject({
      ingest: {
        status: 'done',
        transcriptProvider: 'gemini',
        transcriptTextPath,
        transcriptEvidence: true,
        contentEvidence: true,
      },
    });
  });

  it('defaults to Gemini transcription when a Gemini transcription script is configured', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-api-transcribe-default-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_API_DEFAULT');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const transcriptManifestPath = join(workDir, 'asr', 'transcript-manifest.json');
    const transcriptJsonPath = join(workDir, 'asr', 'transcript.json');
    const videoPath = join(workDir, 'video.mp4');
    const scriptPath = join(rootPath, 'transcribe_audio_gemini.py');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(scriptPath, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "const get = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };",
      "const asrDir = get('--asr-dir');",
      "fs.mkdirSync(asrDir, { recursive: true });",
      "fs.writeFileSync(path.join(asrDir, 'transcript.txt'), '[00:00-00:03] 默认 Gemini 转写成功\\n');",
      "fs.writeFileSync(path.join(asrDir, 'transcript.json'), JSON.stringify({ provider: get('--provider') }, null, 2));",
    ].join('\n'), 'utf8');
    writeJson(sourceInfoPath, {
      video_id: 'BV_API_DEFAULT',
      source_url: 'https://www.bilibili.com/video/BV_API_DEFAULT/',
      ingest: {
        status: 'captured',
        mediaEvidence: true,
        contentEvidence: false,
      },
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_API_DEFAULT',
          status: 'captured',
          platform: 'bilibili',
          videoId: 'BV_API_DEFAULT',
          sourceUrl: 'https://www.bilibili.com/video/BV_API_DEFAULT/',
          title: 'Default API ASR',
          priority: 'normal',
          workDir,
          sourceInfoPath,
          videoPath,
          mediaEvidence: true,
          contentEvidence: false,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.transcribe-local');
    const result = await handler!({ videoId: 'BV_API_DEFAULT' }, {
      connector: createVideoConnector(rootPath, {
        pythonPath: process.execPath,
        transcriptionScriptPath: scriptPath,
      }),
      now: () => '2026-04-21T12:37:00.000Z',
    });

    expect(result.data).toMatchObject({
      outcome: 'transcribed',
      transcriptProvider: 'gemini',
      transcriptEvidence: true,
    });
    expect(JSON.parse(readFileSync(transcriptManifestPath, 'utf8'))).toMatchObject({
      transcriptProvider: 'gemini',
      steps: {
        apiTranscription: {
          skipped: false,
          args: expect.arrayContaining(['--provider', 'gemini']),
        },
      },
    });
    expect(JSON.parse(readFileSync(transcriptJsonPath, 'utf8'))).toMatchObject({
      provider: 'gemini',
    });
  });

  it('accepts ASR provider aliases from direct tool callers', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-api-transcribe-alias-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_API_ALIAS');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const transcriptManifestPath = join(workDir, 'asr', 'transcript-manifest.json');
    const transcriptJsonPath = join(workDir, 'asr', 'transcript.json');
    const videoPath = join(workDir, 'video.mp4');
    const scriptPath = join(rootPath, 'fake-api-transcribe.cjs');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(scriptPath, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "const get = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };",
      "const asrDir = get('--asr-dir');",
      "fs.mkdirSync(asrDir, { recursive: true });",
      "fs.writeFileSync(path.join(asrDir, 'transcript.txt'), '[00:00-00:03] ASR alias 转写成功\\n');",
      "fs.writeFileSync(path.join(asrDir, 'transcript.json'), JSON.stringify({ provider: get('--provider') }, null, 2));",
    ].join('\n'), 'utf8');
    writeJson(sourceInfoPath, {
      video_id: 'BV_API_ALIAS',
      source_url: 'https://www.bilibili.com/video/BV_API_ALIAS/',
      ingest: {
        status: 'captured',
        mediaEvidence: true,
        contentEvidence: false,
      },
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_API_ALIAS',
          status: 'captured',
          platform: 'bilibili',
          videoId: 'BV_API_ALIAS',
          sourceUrl: 'https://www.bilibili.com/video/BV_API_ALIAS/',
          title: 'Alias API ASR',
          priority: 'normal',
          workDir,
          sourceInfoPath,
          videoPath,
          mediaEvidence: true,
          contentEvidence: false,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.transcribe-local');
    const result = await handler!({
      videoId: 'BV_API_ALIAS',
      asrProvider: 'gemini',
      pythonPath: process.execPath,
      transcriptionScriptPath: scriptPath,
    }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:38:00.000Z',
    });

    expect(result.data).toMatchObject({
      outcome: 'transcribed',
      transcriptProvider: 'gemini',
      transcriptEvidence: true,
    });
    expect(JSON.parse(readFileSync(transcriptManifestPath, 'utf8'))).toMatchObject({
      transcriptProvider: 'gemini',
      steps: {
        apiTranscription: {
          args: expect.arrayContaining(['--provider', 'gemini']),
        },
      },
    });
    expect(JSON.parse(readFileSync(transcriptJsonPath, 'utf8'))).toMatchObject({
      provider: 'gemini',
    });
  });

  it('keeps an API transcription dry-run plan separate from transcript artifacts', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-api-transcribe-dry-run-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_API_DRY_RUN');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const transcriptManifestPath = join(workDir, 'asr', 'transcript-manifest.json');
    const transcriptJsonPath = join(workDir, 'asr', 'transcript.json');
    const videoPath = join(workDir, 'video.mp4');
    const scriptPath = join(rootPath, 'fake-api-transcribe-dry-run.cjs');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(scriptPath, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "const get = (name) => args[args.indexOf(name) + 1];",
      "const asrDir = get('--asr-dir');",
      "fs.mkdirSync(asrDir, { recursive: true });",
      "fs.writeFileSync(path.join(asrDir, 'api-transcription-plan.json'), JSON.stringify({ dryRun: true, chunks: [{ start: 0, end: 300 }] }, null, 2));",
    ].join('\n'), 'utf8');
    writeJson(sourceInfoPath, {
      video_id: 'BV_API_DRY_RUN',
      source_url: 'https://www.bilibili.com/video/BV_API_DRY_RUN/',
      ingest: {
        status: 'done',
        mediaEvidence: true,
        contentEvidence: true,
      },
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_API_DRY_RUN',
          status: 'done',
          platform: 'bilibili',
          videoId: 'BV_API_DRY_RUN',
          sourceUrl: 'https://www.bilibili.com/video/BV_API_DRY_RUN/',
          workDir,
          sourceInfoPath,
          videoPath,
          mediaEvidence: true,
          contentEvidence: true,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.transcribe-local');
    const result = await handler!({
      videoId: 'BV_API_DRY_RUN',
      provider: 'gemini',
      pythonPath: process.execPath,
      transcriptionScriptPath: scriptPath,
      dryRun: true,
    }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:36:00.000Z',
    });

    expect(result.resultType).toBe('resource');
    expect(result.data).toMatchObject({
      outcome: 'partial_transcription',
      transcriptProvider: 'gemini',
      transcriptEvidence: false,
      contentEvidence: true,
      job: {
        status: 'done',
        transcriptProvider: 'gemini',
        transcriptEvidence: false,
        contentEvidence: true,
      },
    });
    expect(existsSync(transcriptJsonPath)).toBe(false);
    expect(JSON.parse(readFileSync(transcriptManifestPath, 'utf8'))).toMatchObject({
      transcriptProvider: 'gemini',
      transcriptEvidence: false,
      contentEvidence: true,
      steps: {
        apiTranscription: {
          skipped: false,
        },
      },
    });
  });

  it('runs a configured visual analysis script for a captured video and records visual evidence', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-visual-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_VISUAL');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const videoPath = join(workDir, 'video.mp4');
    const visualWorkDir = join(workDir, 'keyframe_steps');
    const visualSummaryPath = join(visualWorkDir, 'keyframe-steps-summary.json');
    const scriptPath = join(rootPath, 'fake-visual-script.cjs');
    const apiKeyFilePath = join(rootPath, 'gemini.key.txt');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(apiKeyFilePath, 'fake-key', 'utf8');
    writeFileSync(scriptPath, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "const get = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };",
      "const workDir = get('--work-dir');",
      "fs.mkdirSync(workDir, { recursive: true });",
      "fs.writeFileSync(path.join(workDir, 'keyframe-steps-summary.json'), JSON.stringify({",
      "  model: get('--model'),",
      "  mode: get('--mode'),",
      "  source_video: get('--video-path'),",
      "  api_key_file_path: get('--api-key-file'),",
      "  results: [{ segment_range: '00:00-01:15', analysis: { operation_steps: [{ action: 'connect nodes' }] } }]",
      "}, null, 2));",
    ].join('\n'), 'utf8');
    writeJson(sourceInfoPath, {
      video_id: 'BV_VISUAL',
      source_url: 'https://www.bilibili.com/video/BV_VISUAL/',
      ingest: {
        status: 'captured',
        mediaEvidence: true,
        transcriptEvidence: false,
        contentEvidence: false,
      },
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_VISUAL',
          status: 'captured',
          platform: 'bilibili',
          videoId: 'BV_VISUAL',
          sourceUrl: 'https://www.bilibili.com/video/BV_VISUAL/',
          title: 'Captured visual title',
          workDir,
          sourceInfoPath,
          videoPath,
          mediaEvidence: true,
          transcriptEvidence: false,
          contentEvidence: false,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.analyze-visual');
    const result = await handler!({
      videoId: 'BV_VISUAL',
      pythonPath: process.execPath,
      scriptPath,
      model: 'fake-vision-model',
      mode: 'keyframes',
    }, {
      connector: createVideoConnector(rootPath, { geminiApiKeyFilePath: apiKeyFilePath }),
      now: () => '2026-04-21T12:40:00.000Z',
    });

    expect(result.resultType).toBe('resource');
    expect(result.resourceRef).toBe('resource.video_ingest_queue');
    expect(result.data).toMatchObject({
      outcome: 'visual_analyzed',
      selected: true,
      workDir,
      visualWorkDir,
      visualSummaryPath,
      visualEvidence: true,
      contentEvidence: false,
      job: {
        jobId: 'bilibili:BV_VISUAL',
        status: 'visual_analyzed',
        visualEvidence: true,
        contentEvidence: false,
        visualAnalyzedAt: '2026-04-21T12:40:00.000Z',
      },
      stats: {
        queued: 0,
        prepared: 0,
        captured: 0,
        transcribed: 0,
        visualAnalyzed: 1,
        done: 0,
        failed: 0,
        total: 1,
      },
    });

    expect(JSON.parse(readFileSync(visualSummaryPath, 'utf8'))).toMatchObject({
      model: 'fake-vision-model',
      mode: 'keyframes',
      source_video: videoPath,
      api_key_file_path: apiKeyFilePath,
      results: [
        {
          analysis: {
            operation_steps: [
              {
                action: 'connect nodes',
              },
            ],
          },
        },
      ],
    });
    expect(JSON.parse(readFileSync(sourceInfoPath, 'utf8'))).toMatchObject({
      ingest: {
        status: 'visual_analyzed',
        visualAnalyzedAt: '2026-04-21T12:40:00.000Z',
        visualSummaryPath,
        visualEvidence: true,
        contentEvidence: false,
      },
    });
  });

  it('does not mark visual analysis as complete when the summary only contains errors', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-visual-errors-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_VISUAL_ERRORS');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const videoPath = join(workDir, 'video.mp4');
    const visualWorkDir = join(workDir, 'keyframe_steps');
    const visualSummaryPath = join(visualWorkDir, 'keyframe-steps-summary.json');
    const scriptPath = join(rootPath, 'fake-visual-error-script.cjs');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(scriptPath, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "const get = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };",
      "const workDir = get('--work-dir');",
      "fs.mkdirSync(workDir, { recursive: true });",
      "fs.writeFileSync(path.join(workDir, 'keyframe-steps-summary.json'), JSON.stringify({",
      "  results: [{ segment_range: '00:00-01:15', error: true, error_path: 'segment.error.txt' }]",
      "}, null, 2));",
    ].join('\n'), 'utf8');
    writeJson(sourceInfoPath, {
      video_id: 'BV_VISUAL_ERRORS',
      source_url: 'https://www.bilibili.com/video/BV_VISUAL_ERRORS/',
      ingest: {
        status: 'transcribed',
        mediaEvidence: true,
        transcriptEvidence: true,
        visualEvidence: false,
        contentEvidence: false,
      },
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_VISUAL_ERRORS',
          status: 'transcribed',
          platform: 'bilibili',
          videoId: 'BV_VISUAL_ERRORS',
          sourceUrl: 'https://www.bilibili.com/video/BV_VISUAL_ERRORS/',
          title: 'Visual errors title',
          workDir,
          sourceInfoPath,
          videoPath,
          mediaEvidence: true,
          transcriptEvidence: true,
          contentEvidence: false,
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.ingest.analyze-visual');
    const result = await handler!({
      videoId: 'BV_VISUAL_ERRORS',
      pythonPath: process.execPath,
      scriptPath,
      mode: 'keyframes',
    }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:45:00.000Z',
    });

    expect(result.data).toMatchObject({
      outcome: 'partial_visual_analysis',
      visualEvidence: false,
      visualSummaryStats: {
        resultCount: 1,
        usableEntries: 0,
        errorCount: 1,
      },
      job: {
        status: 'transcribed',
        visualEvidence: false,
        visualSummaryStats: {
          resultCount: 1,
          usableEntries: 0,
          errorCount: 1,
        },
      },
      stats: {
        transcribed: 1,
        visualAnalyzed: 0,
      },
    });
    expect(JSON.parse(readFileSync(sourceInfoPath, 'utf8'))).toMatchObject({
      ingest: {
        status: 'transcribed',
        visualEvidence: false,
        visualSummaryStats: {
          resultCount: 1,
          usableEntries: 0,
          errorCount: 1,
        },
      },
    });
  });

  it('composes visual and transcript evidence into searchable video knowledge bundles', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-ingest-compose-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_COMPOSE');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const visualWorkDir = join(workDir, 'keyframe_steps');
    const visualSummaryPath = join(visualWorkDir, 'keyframe-steps-summary.json');
    const transcriptTextPath = join(workDir, 'asr', 'transcript.txt');
    const videoPath = join(workDir, 'video.mp4');
    const screenshotPath = join(workDir, 'evidence_screenshots', 'shot-000015.png');
    const visualFramePath = join(visualWorkDir, 'frames', 'frame-0015.png');
    const bundlePath = join(workDir, 'qwen-style-video-analysis-bundle.json');
    const safeNotesPath = join(workDir, 'hard-subtitle-operation-notes.safe.json');
    const reportInsightsPath = join(workDir, 'video-report-insights.json');
    const legacyWikiCandidatesPath = join(workDir, 'gemini-merged-wiki-candidates-ranged.json');
    const documentPath = join(workDir, 'video-report.md');
    const evidencePath = join(workDir, 'video-evidence.md');
    const documentManifestPath = join(workDir, 'video-document-manifest.json');
    const documentAssetsDir = join(workDir, 'document-assets');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(visualWorkDir, { recursive: true });
    mkdirSync(join(visualWorkDir, 'frames'), { recursive: true });
    mkdirSync(join(workDir, 'asr'), { recursive: true });
    mkdirSync(join(workDir, 'evidence_screenshots'), { recursive: true });
    const videoCreateResult = spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=128x72:rate=1:duration=20',
      '-pix_fmt',
      'yuv420p',
      videoPath,
    ], { encoding: 'utf8' });
    expect(videoCreateResult.status, videoCreateResult.stderr).toBe(0);
    writeFileSync(transcriptTextPath, [
      '[00:15-00:18] 这里开始讲 FlowMap 流动效果',
      '[00:18-00:21] 这是第 2 条转写',
      '[00:21-00:24] 这是第 3 条转写',
      '[00:24-00:27] 这是第 4 条转写',
      '[00:27-00:30] 这是第 5 条转写',
      '[00:30-00:33] 这是第 6 条转写',
      '[00:33-00:36] 这是第 7 条转写',
      '[00:36-00:39] 这是第 8 条转写',
      '[00:39-00:42] 这是第 9 条转写',
      '[00:42-00:45] 这是第 10 条转写',
      '[00:45-00:48] 这是第 11 条转写',
      '[00:48-00:51] 这是第 12 条转写',
      '[00:51-00:54] 第 13 条完整转写应该出现在原文区',
    ].join('\n') + '\n', 'utf8');
    writeFileSync(screenshotPath, 'fake screenshot bytes', 'utf8');
    writeFileSync(visualFramePath, 'fake visual frame bytes', 'utf8');
    writeJson(sourceInfoPath, {
      video_id: 'BV_COMPOSE',
      source_url: 'https://www.bilibili.com/video/BV_COMPOSE/',
      platform_title: '平台标题不一定准确',
      platform: 'bilibili',
      source_metadata: {
        author: '测试UP',
        duration: 75,
      },
      ingest: {
        status: 'visual_analyzed',
        mediaEvidence: true,
        transcriptEvidence: true,
        visualEvidence: true,
        contentEvidence: false,
        wikiCandidatesPath: legacyWikiCandidatesPath,
      },
    });
    writeJson(visualSummaryPath, {
      source_video: videoPath,
      duration_seconds: 75,
      mode: 'keyframes',
      results: [
        {
          index: 0,
          segment_range: '00:00-01:15',
          frame_times: ['00:00', '00:15'],
          frame_paths: [join(visualWorkDir, 'frames', 'frame-0000.png'), visualFramePath],
          analysis: {
            segment_range: '00:00-01:15',
            signal_profile: {
              has_hard_subtitles: true,
              has_screen_recording: true,
              has_code_or_formula: true,
              primary_signal: 'visual',
              confidence: 'high',
            },
            visible_text: [
              {
                time: '00:15',
                text: 'FlowMap',
                source: 'hard_subtitle',
                meaning: '说明正在制作 FlowMap 流动效果。',
                confidence: 'high',
                needs_review: false,
              },
            ],
            code_or_formula: [
              {
                text: 'UV + flow * time',
                kind: 'formula',
                interpretation: '用时间推进 FlowMap 偏移。',
                confidence: 'medium',
                needs_exact_review: true,
              },
            ],
            operation_steps: [
              {
                step_no: 1,
                time: '00:15',
                action: '连接 FlowMap 纹理',
                target: 'Material Graph',
                input_or_value: 'UV offset',
                observed_result: '纹理开始流动',
                confidence: 'high',
                needs_review: false,
              },
            ],
            concepts: [
              {
                title: 'FlowMap 流动效果',
                summary: '通过 FlowMap 纹理和时间偏移制造流动感。',
                evidence: '00:00-01:15',
                confidence: 'high',
              },
            ],
            gotchas: [
              {
                title: 'FlowMap 方向反了',
                symptom: '视觉流动方向不符合预期。',
                cause: '通道方向或 UV 偏移方向相反。',
                fix: '翻转通道或调整偏移方向。',
                evidence: '00:45',
                confidence: 'medium',
              },
            ],
            needs_rewatch: [],
          },
        },
      ],
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_COMPOSE',
          status: 'visual_analyzed',
          platform: 'bilibili',
          videoId: 'BV_COMPOSE',
          sourceUrl: 'https://www.bilibili.com/video/BV_COMPOSE/',
          title: '平台标题不一定准确',
          workDir,
          sourceInfoPath,
          transcriptTextPath,
          visualSummaryPath,
          videoPath,
          mediaEvidence: true,
          transcriptEvidence: true,
          visualEvidence: true,
          contentEvidence: false,
          wikiCandidatesPath: legacyWikiCandidatesPath,
        },
      ],
    });

    const registry = createRegistry();
    const composeHandler = registry.getHandler('video.ingest.compose-bundle');
    const composeResult = await composeHandler!({ videoId: 'BV_COMPOSE' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:50:00.000Z',
    });

    expect(composeResult.resultType).toBe('resource');
    expect(composeResult.resourceRef).toBe('resource.video_ingest_queue');
    const composeData = composeResult.data as { job?: Record<string, unknown> };
    expect(composeData.job).not.toHaveProperty('wikiCandidatesPath');
    expect(composeData).toMatchObject({
      outcome: 'composed',
      selected: true,
      workDir,
      bundlePath,
      safeNotesPath,
      reportInsightsPath,
      contentEvidence: true,
      job: {
        jobId: 'bilibili:BV_COMPOSE',
        status: 'done',
        contentEvidence: true,
        doneAt: '2026-04-21T12:50:00.000Z',
      },
      stats: {
        queued: 0,
        prepared: 0,
        captured: 0,
        transcribed: 0,
        visualAnalyzed: 0,
        done: 1,
        failed: 0,
        total: 1,
      },
    });

    expect(JSON.parse(readFileSync(bundlePath, 'utf8'))).toMatchObject({
      video_id: 'BV_COMPOSE',
      computed_title: 'FlowMap 流动效果',
      platform_title: '平台标题不一定准确',
      operation_notes: [
        {
          title: 'FlowMap 流动效果',
          purpose: '通过 FlowMap 纹理和时间偏移制造流动感。',
          evidence_ranges: ['00:00-01:15'],
          visual_terms: ['FlowMap'],
        },
      ],
      visible_text_evidence: [
        {
          term: 'FlowMap',
          meaning: '说明正在制作 FlowMap 流动效果。',
          evidence_ranges: expect.arrayContaining(['00:15']),
        },
      ],
      formula_or_code_candidates: [
        {
          text: 'UV + flow * time',
          interpretation: '用时间推进 FlowMap 偏移。',
          needs_exact_review: true,
        },
      ],
      gotchas: [
        {
          title: 'FlowMap 方向反了',
          fix_or_check: '翻转通道或调整偏移方向。',
        },
      ],
      key_screenshots: [
        {
          path: visualFramePath,
          time: '00:15',
        },
      ],
      agent_usage: {
        can_answer_how_to: true,
        safe_to_quote_exact_code: false,
      },
    });
    expect(JSON.parse(readFileSync(safeNotesPath, 'utf8'))).toMatchObject({
      video_id: 'BV_COMPOSE',
      operation_notes: [
        {
          title: 'FlowMap 流动效果',
        },
      ],
      agent_usage: {
        safe_to_quote_exact_code: false,
      },
    });
    expect(existsSync(legacyWikiCandidatesPath)).toBe(false);
    const reportInsights = JSON.parse(readFileSync(reportInsightsPath, 'utf8'));
    expect(reportInsights).toMatchObject({
      computed_title: 'FlowMap 流动效果',
      insight_candidates: expect.arrayContaining([
        expect.objectContaining({
          title: 'FlowMap 流动效果',
          report_use: 'concept_reference',
        }),
      ]),
    });
    expect(JSON.stringify(reportInsights)).not.toContain('wiki');
    expect(JSON.stringify(reportInsights)).not.toContain('沉淀');
    expect(JSON.parse(readFileSync(sourceInfoPath, 'utf8'))).toMatchObject({
      ingest: {
        status: 'done',
        composedAt: '2026-04-21T12:50:00.000Z',
        bundlePath,
        safeNotesPath,
        reportInsightsPath,
        contentEvidence: true,
      },
    });
    expect(JSON.parse(readFileSync(sourceInfoPath, 'utf8')).ingest).not.toHaveProperty('wikiCandidatesPath');

    const documentHandler = registry.getHandler('video.ingest.compose-document');
    const documentResult = await documentHandler!({
      videoId: 'BV_COMPOSE',
      autoKeyframeSelection: 'false',
    }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:55:00.000Z',
    });

    expect(documentResult.resultType).toBe('resource');
    expect(documentResult.resourceRef).toBe('resource.video_ingest_queue');
    expect(documentResult.data).toMatchObject({
      outcome: 'documented',
      selected: true,
      workDir,
      documentPath,
      reportPath: documentPath,
      evidencePath,
      documentManifestPath,
      documentAssetsDir,
      documentEvidence: true,
      boundary: {
        scope: 'video_report_only',
        outputOnly: true,
      },
      counts: {
        documentAssets: 1,
        videoFrameAssets: 1,
        sourceFrameAssets: 0,
      },
    });
    const documentAssetPath = join(documentAssetsDir, 'frame-0015.png');
    expect(existsSync(documentAssetPath)).toBe(true);
    expect(readFileSync(documentAssetPath, 'utf8')).not.toBe('fake visual frame bytes');
    const assetProbeResult = spawnSync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      documentAssetPath,
    ], { encoding: 'utf8' });
    expect(assetProbeResult.status, assetProbeResult.stderr).toBe(0);
    expect(JSON.parse(assetProbeResult.stdout)).toMatchObject({
      streams: [
        {
          width: 128,
          height: 72,
        },
      ],
    });

    const documentMarkdown = readFileSync(documentPath, 'utf8');
    expect(documentMarkdown).toContain('# 平台标题不一定准确');
    expect(documentMarkdown).toContain('## 关键词');
    expect(documentMarkdown).toContain('## 全文摘要');
    expect(documentMarkdown).toContain('## 语音/音频');
    expect(documentMarkdown).toContain('ASR：已生成');
    expect(documentMarkdown).toContain('## 章节速览');
    expect(documentMarkdown).toContain('## 要点回顾');
    expect(documentMarkdown).toContain('## 原文/字幕');
    expect(documentMarkdown).toContain('平台标题不一定准确');
    expect(documentMarkdown).toContain('00:00-01:15');
    expect(documentMarkdown).toContain('![FlowMap 流动效果](document-assets/frame-0015.png)');
    expect(documentMarkdown).toContain('这段视频主要讲什么？');
    expect(documentMarkdown).toContain('[00:15-00:18] 这里开始讲 FlowMap 流动效果');
    expect(documentMarkdown).toContain('[00:51-00:54] 第 13 条完整转写应该出现在原文区');
    expect(documentMarkdown).not.toContain('已导入 wiki');

    const evidenceMarkdown = readFileSync(evidencePath, 'utf8');
    expect(evidenceMarkdown).toContain('本文档只提供视频证据');
    expect(evidenceMarkdown).not.toContain('知识库');
    expect(evidenceMarkdown).toContain('画面判断');
    expect(evidenceMarkdown).toContain('音频/字幕');
    expect(evidenceMarkdown).toContain('[00:15-00:18] 这里开始讲 FlowMap 流动效果');

    expect(JSON.parse(readFileSync(documentManifestPath, 'utf8'))).toMatchObject({
      videoId: 'BV_COMPOSE',
      documentType: 'video_report',
      documentPath,
      reportPath: documentPath,
      evidencePath,
      assetsDirectory: documentAssetsDir,
      videoPath,
      boundary: {
        scope: 'video_report_only',
        outputOnly: true,
      },
      assets: [
        {
          sourcePath: visualFramePath,
          assetSource: 'video_frame',
          relativePath: 'document-assets/frame-0015.png',
          time: '00:15',
        },
      ],
    });
    expect(JSON.parse(readFileSync(sourceInfoPath, 'utf8'))).toMatchObject({
      ingest: {
        documentedAt: '2026-04-21T12:55:00.000Z',
        documentPath,
        reportPath: documentPath,
        evidencePath,
        documentManifestPath,
        documentEvidence: true,
      },
    });

    const searchHandler = registry.getHandler('video.knowledge.search');
    const searchResult = await searchHandler!({ query: 'FlowMap' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T12:51:00.000Z',
    });

    const searchItems = (searchResult.data as { items: Array<Record<string, unknown>> }).items;
    expect(searchItems[0]).toMatchObject({
      videoId: 'BV_COMPOSE',
      title: '平台标题不一定准确',
    });
    expect(searchItems[0]?.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'operation_note',
        title: 'FlowMap 流动效果',
      }),
    ]));
  });

  it('uses a specific platform title for the report when the visual title is generic', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-report-title-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_GENERIC_TITLE');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const bundlePath = join(workDir, 'qwen-style-video-analysis-bundle.json');
    const probePath = join(workDir, 'probe.json');
    const asrDir = join(workDir, 'asr');
    const transcriptManifestPath = join(asrDir, 'transcript-manifest.json');
    const documentPath = join(workDir, 'video-report.md');
    const evidencePath = join(workDir, 'video-evidence.md');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(asrDir, { recursive: true });
    writeJson(probePath, {
      streams: [
        {
          index: 1,
          codec_name: 'aac',
          codec_type: 'audio',
          channels: 2,
          duration: '1014.634333',
        },
      ],
    });
    writeJson(transcriptManifestPath, {
      transcriptEvidence: false,
      preview: [],
      steps: {
        whisper: {
          skipped: true,
          reason: 'whisper_disabled',
        },
      },
    });
    writeJson(sourceInfoPath, {
      video_id: 'BV_GENERIC_TITLE',
      source_url: 'https://www.bilibili.com/video/BV_GENERIC_TITLE/',
      platform_title: '【UE5进阶】细聊黑客帝国后处理特效02 - HLSL FlowMap',
      ingest: {
        status: 'done',
        contentEvidence: true,
        bundlePath,
        probePath,
        transcriptManifestPath,
        transcriptEvidence: false,
      },
    });
    writeJson(bundlePath, {
      video_id: 'BV_GENERIC_TITLE',
      source_url: 'https://www.bilibili.com/video/BV_GENERIC_TITLE/',
      platform_title: '【UE5进阶】细聊黑客帝国后处理特效02 - HLSL FlowMap',
      computed_title: 'Material Graph Editing',
      timeline_segments: [
        {
          start: '00:00',
          end: '01:15',
          topic: 'Material Graph Editing',
          summary: 'Understanding how to connect nodes and adjust parameters in a visual material editor.',
        },
      ],
      operation_notes: [
        {
          title: 'Material Graph Editing',
          purpose: 'Understanding how to connect nodes and adjust parameters in a visual material editor.',
          evidence_ranges: ['00:00-01:15'],
          visual_terms: ['HLSL', 'FlowMap', 'Material Graph'],
        },
      ],
      key_screenshots: [],
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_GENERIC_TITLE',
          status: 'done',
          platform: 'bilibili',
          videoId: 'BV_GENERIC_TITLE',
          workDir,
          sourceInfoPath,
          bundlePath,
          probePath,
          transcriptManifestPath,
          contentEvidence: true,
        },
      ],
    });

    const registry = createRegistry();
    const documentHandler = registry.getHandler('video.ingest.compose-document');
    const documentResult = await documentHandler!({ videoId: 'BV_GENERIC_TITLE' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T13:05:00.000Z',
    });

    expect(documentResult.data).toMatchObject({
      documentPath,
      reportPath: documentPath,
      evidencePath,
      counts: {
        documentAssets: 0,
      },
    });

    const reportMarkdown = readFileSync(documentPath, 'utf8');
    expect(reportMarkdown).toContain('# 【UE5进阶】细聊黑客帝国后处理特效02 - HLSL FlowMap');
    expect(reportMarkdown).toContain('这是一段围绕【UE5进阶】细聊黑客帝国后处理特效02 - HLSL FlowMap的视频内容报告。');
    expect(reportMarkdown).toContain('## 语音/音频');
    expect(reportMarkdown).toContain('音轨：存在');
    expect(reportMarkdown).toContain('ASR：未生成');
    expect(reportMarkdown).toContain('Whisper 未运行');
    expect(reportMarkdown).toContain('- 视觉判断标题：Material Graph Editing');
  });

  it('keeps the platform title as the report heading when visual inference has a different specific title', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-report-title-platform-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_TITLE_KEEP');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const bundlePath = join(workDir, 'qwen-style-video-analysis-bundle.json');
    const documentPath = join(workDir, 'video-report.md');
    const evidencePath = join(workDir, 'video-evidence.md');
    const documentManifestPath = join(workDir, 'video-document-manifest.json');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeJson(sourceInfoPath, {
      video_id: 'BV_TITLE_KEEP',
      source_url: 'https://www.bilibili.com/video/BV_TITLE_KEEP/',
      platform_title: 'UE5材质，圆盘抽奖',
      ingest: {
        status: 'done',
        contentEvidence: true,
        bundlePath,
      },
    });
    writeJson(bundlePath, {
      video_id: 'BV_TITLE_KEEP',
      source_url: 'https://www.bilibili.com/video/BV_TITLE_KEEP/',
      platform_title: 'UE5材质，圆盘抽奖',
      computed_title: 'Visual Puzzle Solving',
      timeline_segments: [
        {
          start: '00:00',
          end: '00:45',
          topic: 'UE5材质抽奖圆盘',
          summary: '演示材质节点中圆盘抽奖效果的构建。',
        },
      ],
      operation_notes: [
        {
          title: 'UE5材质抽奖圆盘',
          purpose: '说明如何制作圆盘抽奖材质效果。',
          evidence_ranges: ['00:00-00:45'],
          visual_terms: ['UE5', '材质', '圆盘'],
        },
      ],
      key_screenshots: [],
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_TITLE_KEEP',
          status: 'done',
          platform: 'bilibili',
          videoId: 'BV_TITLE_KEEP',
          workDir,
          sourceInfoPath,
          bundlePath,
          contentEvidence: true,
        },
      ],
    });

    const registry = createRegistry();
    const documentHandler = registry.getHandler('video.ingest.compose-document');
    await documentHandler!({ videoId: 'BV_TITLE_KEEP' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T13:08:00.000Z',
    });

    const reportMarkdown = readFileSync(documentPath, 'utf8');
    expect(existsSync(evidencePath)).toBe(true);
    expect(existsSync(documentManifestPath)).toBe(true);
    expect(reportMarkdown).toContain('# UE5材质，圆盘抽奖');
    expect(reportMarkdown).toContain('- 视觉判断标题：Visual Puzzle Solving');
  });

  it('can compose an experimental report from a hybrid keyframe manifest without replacing canonical report files', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-report-hybrid-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_HYBRID_DOC');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const bundlePath = join(workDir, 'qwen-style-video-analysis-bundle.json');
    const officialReportPath = join(workDir, 'video-report.md');
    const officialEvidencePath = join(workDir, 'video-evidence.md');
    const hybridManifestPath = join(workDir, '_keyframe-experiment', 'hybrid-030.manifest.json');
    const hybridFrameDir = join(workDir, '_keyframe-experiment', 'hybrid-030');
    const hybridFramePathA = join(hybridFrameDir, 'shot-000000.png');
    const hybridFramePathB = join(hybridFrameDir, 'shot-000030.png');
    const documentPath = join(workDir, 'video-report.hybrid-keyframes.md');
    const evidencePath = join(workDir, 'video-evidence.hybrid-keyframes.md');
    const documentManifestPath = join(workDir, 'video-document-manifest.hybrid-keyframes.json');
    const documentAssetsDir = join(workDir, 'document-assets-hybrid-keyframes');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(hybridFrameDir, { recursive: true });
    writeFileSync(officialReportPath, '# official report\n', 'utf8');
    writeFileSync(officialEvidencePath, '# official evidence\n', 'utf8');
    writeFileSync(hybridFramePathA, 'hybrid frame a', 'utf8');
    writeFileSync(hybridFramePathB, 'hybrid frame b', 'utf8');
    writeJson(sourceInfoPath, {
      video_id: 'BV_HYBRID_DOC',
      source_url: 'https://www.bilibili.com/video/BV_HYBRID_DOC/',
      platform_title: 'Hybrid keyframe test',
      ingest: {
        status: 'done',
        contentEvidence: true,
        bundlePath,
      },
    });
    writeJson(bundlePath, {
      video_id: 'BV_HYBRID_DOC',
      source_url: 'https://www.bilibili.com/video/BV_HYBRID_DOC/',
      platform_title: 'Hybrid keyframe test',
      computed_title: 'Hybrid keyframe report',
      timeline_segments: [
        {
          start: '00:00',
          end: '00:45',
          topic: 'Hybrid 关键帧密度测试',
          summary: '用实验关键帧清单提高报告截图密度。',
        },
      ],
      operation_notes: [
        {
          title: 'Hybrid 关键帧密度测试',
          purpose: '验证实验版报告可以使用 hybrid keyframe manifest。',
          evidence_ranges: ['00:00-00:45'],
          visual_terms: ['hybrid', 'keyframe'],
        },
      ],
      key_screenshots: [],
    });
    writeJson(hybridManifestPath, {
      strategy: 'hybrid',
      selectedCount: 2,
      selected: [
        {
          timestamp: 0,
          path: hybridFramePathA,
          reasons: ['best_quality_in_visual_cluster', 'coverage_window'],
        },
        {
          timestamp: 30,
          path: hybridFramePathB,
          reasons: ['gap_filler'],
        },
      ],
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_HYBRID_DOC',
          status: 'done',
          platform: 'bilibili',
          videoId: 'BV_HYBRID_DOC',
          workDir,
          sourceInfoPath,
          bundlePath,
          contentEvidence: true,
        },
      ],
    });

    const registry = createRegistry();
    const documentHandler = registry.getHandler('video.ingest.compose-document');
    const result = await documentHandler!({
      videoId: 'BV_HYBRID_DOC',
      documentVariant: 'hybrid-keyframes',
      keyframeManifestPath: hybridManifestPath,
    }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T13:15:00.000Z',
    });

    expect(result.data).toMatchObject({
      outcome: 'documented',
      experimental: true,
      canonical: false,
      documentPath,
      reportPath: documentPath,
      evidencePath,
      documentManifestPath,
      documentAssetsDir,
      keyframeSelection: {
        source: 'keyframe_manifest',
        manifestPath: hybridManifestPath,
        strategy: 'hybrid',
        selectedCount: 2,
      },
      counts: {
        screenshots: 2,
        documentAssets: 2,
      },
    });
    expect(readFileSync(officialReportPath, 'utf8')).toBe('# official report\n');
    expect(readFileSync(officialEvidencePath, 'utf8')).toBe('# official evidence\n');
    expect(existsSync(join(documentAssetsDir, 'shot-000000.png'))).toBe(true);
    expect(existsSync(join(documentAssetsDir, 'shot-000030.png'))).toBe(true);

    const reportMarkdown = readFileSync(documentPath, 'utf8');
    expect(reportMarkdown).toContain('![Hybrid 关键帧密度测试](document-assets-hybrid-keyframes/shot-000000.png)');
    expect(reportMarkdown).toContain('[shot-000030.png](document-assets-hybrid-keyframes/shot-000030.png)');

    expect(JSON.parse(readFileSync(documentManifestPath, 'utf8'))).toMatchObject({
      videoId: 'BV_HYBRID_DOC',
      documentType: 'video_report_experimental',
      experimental: true,
      canonical: false,
      assetsDirectory: documentAssetsDir,
      keyframeSelection: {
        source: 'keyframe_manifest',
        manifestPath: hybridManifestPath,
        strategy: 'hybrid',
        selectedCount: 2,
      },
      assets: [
        {
          sourcePath: hybridFramePathA,
          relativePath: 'document-assets-hybrid-keyframes/shot-000000.png',
          time: '00:00',
        },
        {
          sourcePath: hybridFramePathB,
          relativePath: 'document-assets-hybrid-keyframes/shot-000030.png',
          time: '00:30',
        },
      ],
    });
    expect(JSON.parse(readFileSync(sourceInfoPath, 'utf8')).ingest).not.toHaveProperty('documentPath');
  });

  it('uses the semantic tight keyframe selector by default when composing a canonical report', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-report-semantic-tight-'));
    const queuePath = join(rootPath, '_queues', 'video-ingest.json');
    const workDir = join(rootPath, 'BV_TIGHT_DOC');
    const sourceInfoPath = join(workDir, 'source.info.json');
    const bundlePath = join(workDir, 'qwen-style-video-analysis-bundle.json');
    const visualSummaryPath = join(workDir, 'keyframe_steps', 'keyframe-steps-summary.json');
    const selectorScriptPath = join(rootPath, 'fake-select-keyframes.cjs');
    const videoPath = join(workDir, 'video.mp4');
    const documentPath = join(workDir, 'video-report.md');
    const evidencePath = join(workDir, 'video-evidence.md');
    const documentManifestPath = join(workDir, 'video-document-manifest.json');
    const documentAssetsDir = join(workDir, 'document-assets');
    const staleAssetPath = join(documentAssetsDir, 'stale-frame.png');
    const autoManifestPath = join(workDir, '_keyframe-experiment', 'semantic-tight-keyframes.manifest.json');

    mkdirSync(join(rootPath, '_queues'), { recursive: true });
    mkdirSync(join(workDir, 'keyframe_steps'), { recursive: true });
    mkdirSync(documentAssetsDir, { recursive: true });
    writeFileSync(staleAssetPath, 'old image', 'utf8');
    writeFileSync(videoPath, 'fake mp4 bytes', 'utf8');
    writeFileSync(selectorScriptPath, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "const get = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };",
      "const outDir = get('--out');",
      "const manifestPath = get('--manifest');",
      "fs.mkdirSync(outDir, { recursive: true });",
      "fs.mkdirSync(path.dirname(manifestPath), { recursive: true });",
      "fs.writeFileSync(path.join(outDir, 'shot-000000.png'), 'tight frame 0');",
      "fs.writeFileSync(path.join(outDir, 'shot-000078.png'), 'tight frame 78');",
      "fs.writeFileSync(path.join(path.dirname(manifestPath), 'selector-args.json'), JSON.stringify(args, null, 2));",
      "fs.writeFileSync(manifestPath, JSON.stringify({",
      "  strategy: 'hybrid',",
      "  algorithm: 'hybrid_visual_cluster_plus_timeline_coverage_and_semantic_scoring',",
      "  selectedCount: 2,",
      "  semanticSignalCount: 5,",
      "  selected: [",
      "    { timestamp: 0, path: path.join(outDir, 'shot-000000.png'), reasons: ['semantic_signal'] },",
      "    { timestamp: 78, path: path.join(outDir, 'shot-000078.png'), reasons: ['best_quality_in_visual_cluster', 'semantic_signal'] }",
      "  ]",
      "}, null, 2));",
    ].join('\n'), 'utf8');
    writeJson(visualSummaryPath, {
      results: [
        {
          segment_range: '00:00-01:15',
          analysis: {
            visible_text: [{ time: '00:10', text: 'Blueprint AI', source: 'ui_label', confidence: 'high' }],
          },
        },
      ],
    });
    writeJson(sourceInfoPath, {
      video_id: 'BV_TIGHT_DOC',
      source_url: 'https://www.bilibili.com/video/BV_TIGHT_DOC/',
      platform_title: 'Semantic tight test',
      ingest: {
        status: 'done',
        contentEvidence: true,
        bundlePath,
        visualSummaryPath,
        videoPath,
      },
    });
    writeJson(bundlePath, {
      video_id: 'BV_TIGHT_DOC',
      source_url: 'https://www.bilibili.com/video/BV_TIGHT_DOC/',
      platform_title: 'Semantic tight test',
      computed_title: 'Semantic tight report',
      local_video: videoPath,
      paths: {
        visual_summary: visualSummaryPath,
      },
      timeline_segments: [
        {
          start: '00:00',
          end: '01:30',
          topic: 'Semantic tight 截图策略',
          summary: '默认使用语义 tight 截图策略减少无效画面。',
        },
      ],
      operation_notes: [
        {
          title: 'Semantic tight 截图策略',
          purpose: '报告默认只保留高价值语义截图。',
          evidence_ranges: ['00:00-01:30'],
          visual_terms: ['semantic', 'tight'],
        },
      ],
      key_screenshots: [],
    });
    writeJson(queuePath, {
      version: 1,
      jobs: [
        {
          jobId: 'bilibili:BV_TIGHT_DOC',
          status: 'done',
          platform: 'bilibili',
          videoId: 'BV_TIGHT_DOC',
          workDir,
          sourceInfoPath,
          bundlePath,
          visualSummaryPath,
          videoPath,
          contentEvidence: true,
        },
      ],
    });

    const registry = createRegistry();
    const documentHandler = registry.getHandler('video.ingest.compose-document');
    const result = await documentHandler!({
      videoId: 'BV_TIGHT_DOC',
      pythonPath: process.execPath,
      keyframeSelectorScriptPath: selectorScriptPath,
    }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-21T13:25:00.000Z',
    });

    expect(result.data).toMatchObject({
      outcome: 'documented',
      experimental: false,
      canonical: true,
      documentPath,
      evidencePath,
      documentManifestPath,
      documentAssetsDir,
      keyframeSelection: {
        source: 'keyframe_manifest',
        manifestPath: autoManifestPath,
        algorithm: 'hybrid_visual_cluster_plus_timeline_coverage_and_semantic_scoring',
        selectedCount: 2,
      },
      counts: {
        screenshots: 2,
        documentAssets: 2,
      },
    });

    expect(existsSync(join(documentAssetsDir, 'shot-000000.png'))).toBe(true);
    expect(existsSync(join(documentAssetsDir, 'shot-000078.png'))).toBe(true);
    expect(existsSync(staleAssetPath)).toBe(false);

    const selectorArgs = JSON.parse(readFileSync(join(workDir, '_keyframe-experiment', 'selector-args.json'), 'utf8'));
    expect(selectorArgs).toEqual(expect.arrayContaining([
      videoPath,
      '--strategy',
      'hybrid',
      '--semantic-manifest',
      visualSummaryPath,
      '--semantic-min-score',
      '0.80',
      '--max-frames-per-minute',
      '3',
      '--manifest',
      autoManifestPath,
    ]));
    expect(readFileSync(documentPath, 'utf8')).toContain('![Semantic tight 截图策略](document-assets/shot-000000.png)');
    expect(JSON.parse(readFileSync(sourceInfoPath, 'utf8'))).toMatchObject({
      ingest: {
        documentPath,
        reportPath: documentPath,
        evidencePath,
        documentManifestPath,
        documentAssetsDir,
      },
    });
  });

  it('lists the official Bilibili favorites index with status filters and pagination', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-favorites-list-'));
    const collectionsPath = join(rootPath, '_collections');
    const officialIndexPath = join(collectionsPath, 'bilibili-favorites.json');
    const partialIndexPath = join(collectionsPath, 'bilibili-favorites.partial.json');

    mkdirSync(collectionsPath, { recursive: true });
    writeJson(officialIndexPath, {
      platform: 'bilibili',
      syncedAt: '2026-04-20T12:00:00.000Z',
      folders: [
        {
          folderId: '1001',
          title: 'Shader 收藏',
          mediaCount: 2,
        },
        {
          folderId: '1002',
          title: 'Niagara 收藏',
          mediaCount: 1,
        },
      ],
      videos: [
        {
          bvid: 'BV_PENDING_1',
          title: 'HLSL length 讲解',
          folderId: '1001',
          folderTitle: 'Shader 收藏',
          author: 'UP主A',
          ingestStatus: 'pending',
        },
        {
          bvid: 'BV_DONE_1',
          title: '已经生成报告的视频',
          folderId: '1001',
          folderTitle: 'Shader 收藏',
          author: 'UP主B',
          ingestStatus: 'done',
        },
        {
          bvid: 'BV_PENDING_2',
          title: 'Niagara float3 示例',
          folderId: '1002',
          folderTitle: 'Niagara 收藏',
          author: 'UP主C',
          ingestStatus: 'pending',
        },
      ],
      stats: {
        folders: 2,
        videos: 3,
      },
      syncOptions: {
        partial: false,
      },
    });
    writeJson(partialIndexPath, {
      platform: 'bilibili',
      videos: [
        {
          bvid: 'BV_PARTIAL_ONLY',
          title: 'Partial only video',
          ingestStatus: 'pending',
        },
      ],
      syncOptions: {
        partial: true,
      },
    });

    const registry = createRegistry();
    const handler = registry.getHandler('bilibili.favorites.list');
    const result = await handler!({ status: 'pending', limit: '1', offset: '1' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });

    expect(result.resultType).toBe('resource_list');
    expect(result.resourceRef).toBe('resource.bilibili_favorites');
    expect(result.data).toMatchObject({
      source: 'official',
      indexPath: officialIndexPath,
      partial: false,
      total: 3,
      count: 1,
      offset: 1,
      limit: 1,
      metadataOnly: true,
      contentEvidence: false,
      folders: [
        {
          folderId: '1001',
          title: 'Shader 收藏',
        },
        {
          folderId: '1002',
          title: 'Niagara 收藏',
        },
      ],
      items: [
        {
          bvid: 'BV_DONE_1',
          title: '已经生成报告的视频',
          ingestStatus: 'pending',
        },
      ],
    });
  });

  it('computes favorite ingest status from local BV artifacts after folder moves or renames', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-favorites-lifecycle-'));
    const collectionsPath = join(rootPath, '_collections');
    const officialIndexPath = join(collectionsPath, 'bilibili-favorites.json');

    mkdirSync(collectionsPath, { recursive: true });
    createDocumentedBilibiliVideo(rootPath, 'BV_MOVED', '已处理但被移动的视频');
    writeJson(officialIndexPath, {
      platform: 'bilibili',
      syncedAt: '2026-05-03T02:00:00.000Z',
      folders: [
        {
          folderId: '2002',
          title: '新收藏夹名',
          mediaCount: 1,
        },
      ],
      videos: [
        {
          bvid: 'BV_MOVED',
          title: '收藏夹里的当前标题',
          folderId: '2002',
          folderTitle: '新收藏夹名',
          ingestStatus: 'pending',
        },
      ],
      syncOptions: {
        partial: false,
      },
    });

    const registry = createRegistry();
    const handler = registry.getHandler('bilibili.favorites.list');
    const doneResult = await handler!({ status: 'done' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-05-03T02:00:00.000Z',
    });
    const pendingResult = await handler!({ status: 'pending' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-05-03T02:00:00.000Z',
    });

    expect(doneResult.data).toMatchObject({
      source: 'official',
      total: 1,
      items: [
        {
          bvid: 'BV_MOVED',
          videoKey: 'bilibili:BV_MOVED',
          favoriteStatus: 'active_favorite',
          ingestStatus: 'done',
          processingStatus: 'documented',
          processingComplete: true,
          currentFavoriteFolders: [
            {
              folderId: '2002',
              folderTitle: '新收藏夹名',
            },
          ],
          localPaths: {
            reportPath: expect.stringContaining('video-report.md'),
            evidencePath: expect.stringContaining('video-evidence.md'),
            documentManifestPath: expect.stringContaining('video-document-manifest.json'),
            documentAssetsDir: expect.stringContaining('document-assets'),
          },
        },
      ],
    });
    expect(pendingResult.data).toMatchObject({
      total: 0,
      items: [],
    });
  });

  it('lists local Bilibili artifacts that no longer appear in the current favorites snapshot as orphans', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-favorites-orphans-'));
    const collectionsPath = join(rootPath, '_collections');
    const officialIndexPath = join(collectionsPath, 'bilibili-favorites.json');

    mkdirSync(collectionsPath, { recursive: true });
    createDocumentedBilibiliVideo(rootPath, 'BVACTIVE123', '仍在收藏的视频');
    const orphanPath = createDocumentedBilibiliVideo(rootPath, 'BVORPHAN123', '已采集但当前不在收藏夹的视频');
    writeFileSync(join(orphanPath, 'source.info.json'), `\uFEFF${JSON.stringify({
      platform: 'bilibili',
      platform_title: '带 BOM 的旧 source info',
      source_url: 'https://www.bilibili.com/video/BVORPHAN123/',
    })}\n`, 'utf8');
    writeJson(officialIndexPath, {
      platform: 'bilibili',
      syncedAt: '2026-05-03T02:00:00.000Z',
      folders: [
        {
          folderId: '3003',
          title: '当前收藏夹',
          mediaCount: 1,
        },
      ],
      videos: [
        {
          bvid: 'BVACTIVE123',
          title: '仍在收藏的视频',
          folderId: '3003',
          folderTitle: '当前收藏夹',
          ingestStatus: 'pending',
        },
      ],
      syncOptions: {
        partial: false,
      },
    });

    const registry = createRegistry();
    const handler = registry.getHandler('bilibili.favorites.orphans');
    const result = await handler!({ status: 'processed' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-05-03T02:00:00.000Z',
    });

    expect(result.resultType).toBe('resource_list');
    expect(result.resourceRef).toBe('resource.bilibili_favorite_orphans');
    expect(result.data).toMatchObject({
      source: 'official',
      indexPath: officialIndexPath,
      metadataOnly: true,
      contentEvidence: false,
      total: 1,
      count: 1,
      stats: {
        orphaned: 1,
        processedOrphaned: 1,
        localOnly: 0,
      },
      items: [
        {
          bvid: 'BVORPHAN123',
          videoKey: 'bilibili:BVORPHAN123',
          favoriteStatus: 'not_in_current_favorites',
          orphanReason: 'processed_unfavorited_or_source_removed',
          availabilityStatus: 'unknown',
          ingestStatus: 'done',
          processingStatus: 'documented',
          processingComplete: true,
          currentFavoriteFolders: [],
          localPaths: {
            reportPath: expect.stringContaining('video-report.md'),
          },
        },
      ],
    });
  });

  it('searches Bilibili favorites metadata and only reads the partial index when requested', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-favorites-search-'));
    const collectionsPath = join(rootPath, '_collections');
    const officialIndexPath = join(collectionsPath, 'bilibili-favorites.json');
    const partialIndexPath = join(collectionsPath, 'bilibili-favorites.partial.json');

    mkdirSync(collectionsPath, { recursive: true });
    writeJson(officialIndexPath, {
      platform: 'bilibili',
      syncedAt: '2026-04-20T12:00:00.000Z',
      folders: [],
      videos: [
        {
          bvid: 'BV_OFFICIAL',
          title: '正式索引里的 HLSL 视频',
          folderTitle: 'Shader 收藏',
          author: 'UP主A',
          ingestStatus: 'pending',
        },
      ],
      syncOptions: {
        partial: false,
      },
    });
    writeJson(partialIndexPath, {
      platform: 'bilibili',
      syncedAt: '2026-04-20T12:01:00.000Z',
      folders: [],
      videos: [
        {
          bvid: 'BV_PARTIAL',
          title: 'Partial 队列里的 Kimi 视频',
          folderTitle: 'AI 收藏',
          author: 'UP主P',
          ingestStatus: 'pending',
        },
      ],
      syncOptions: {
        partial: true,
      },
    });

    const registry = createRegistry();
    const handler = registry.getHandler('bilibili.favorites.search');
    const officialResult = await handler!({ query: 'Partial 队列' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });
    const partialResult = await handler!({ query: 'Partial 队列', source: 'partial' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });

    expect(officialResult.data).toMatchObject({
      source: 'official',
      indexPath: officialIndexPath,
      total: 0,
      items: [],
    });
    expect(partialResult.data).toMatchObject({
      source: 'partial',
      indexPath: partialIndexPath,
      partial: true,
      total: 1,
      metadataOnly: true,
      contentEvidence: false,
      items: [
        {
          bvid: 'BV_PARTIAL',
          title: 'Partial 队列里的 Kimi 视频',
          author: 'UP主P',
        },
      ],
    });
  });

  it('lists current Bilibili favorite folders and counts without listing videos', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-favorite-folders-'));
    const collectionsPath = join(rootPath, '_collections');

    mkdirSync(collectionsPath, { recursive: true });
    writeJson(join(collectionsPath, 'bilibili-favorites.json'), {
      platform: 'bilibili',
      syncedAt: '2026-04-19T00:00:00.000Z',
      folders: [
        {
          folderId: 'OLD',
          title: '旧缓存',
          mediaCount: 999,
        },
      ],
      videos: [
        {
          bvid: 'BV_OLD_CACHE',
          title: '旧缓存视频',
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('bilibili.favorites.folders');
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);

      if (href.includes('/x/web-interface/nav')) {
        return Response.json({
          code: 0,
          data: {
            isLogin: true,
            mid: 42,
            uname: '收藏测试账号',
          },
        });
      }

      if (href.includes('/x/v3/fav/folder/created/list-all')) {
        return Response.json({
          code: 0,
          data: {
            list: [
              {
                id: 1001,
                media_id: 1001,
                title: 'Shader 收藏',
                media_count: 2,
              },
              {
                id: 1002,
                media_id: 1002,
                title: '空文件夹',
                media_count: 0,
              },
            ],
          },
        });
      }

      throw new Error(`Unexpected request: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handler!({}, {
      connector: createBilibiliConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });

    expect(result.resultType).toBe('resource_list');
    expect(result.resourceRef).toBe('resource.bilibili_favorite_folders');
    expect(result.data).toMatchObject({
      platform: 'bilibili',
      source: 'live',
      fetchedAt: '2026-04-20T12:00:00.000Z',
      metadataOnly: true,
      contentEvidence: false,
      total: 2,
      count: 2,
      mediaCountTotal: 2,
      account: {
        mid: 42,
        uname: '收藏测试账号',
      },
      folders: [
        {
          folderId: '1001',
          title: 'Shader 收藏',
          mediaCount: 2,
        },
        {
          folderId: '1002',
          title: '空文件夹',
          mediaCount: 0,
        },
      ],
      presentation: {
        markdown: [
          'B站账号 @收藏测试账号 共有 2 个收藏夹，合计 2 个视频。',
          '',
          '| 收藏夹 | 数量 |',
          '|--------|-----:|',
          '| Shader 收藏 | 2 |',
          '| 空文件夹 | 0 |',
          '',
          '数据取自 B站 live API（2026-04-20T12:00:00.000Z）。',
        ].join('\n'),
        rowCount: 2,
        mediaCountTotal: 2,
      },
      validation: {
        expectedRows: 2,
        expectedMediaCountTotal: 2,
      },
    });
    expect(result.data).not.toHaveProperty('items');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/x/v3/fav/resource/list'))).toBe(false);
  });

  it('syncs Bilibili favorite folders and videos into a local collection index', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-favorites-'));
    const registry = createRegistry();
    const handler = registry.getHandler('bilibili.favorites.sync');
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);

      if (href.includes('/x/web-interface/nav')) {
        return Response.json({
          code: 0,
          data: {
            isLogin: true,
            mid: 42,
            uname: '收藏测试账号',
          },
        });
      }

      if (href.includes('/x/v3/fav/folder/created/list-all')) {
        return Response.json({
          code: 0,
          data: {
            list: [
              {
                id: 1001,
                media_id: 1001,
                title: 'Shader 收藏',
                media_count: 2,
              },
            ],
          },
        });
      }

      if (href.includes('/x/v3/fav/resource/list')) {
        return Response.json({
          code: 0,
          data: {
            info: {
              id: 1001,
              title: 'Shader 收藏',
              media_count: 2,
            },
            medias: [
              {
                bvid: 'BV_SYNC_1',
                title: 'HLSL length 讲解',
                duration: 684,
                ctime: 1710000000,
                fav_time: 1710000100,
                upper: {
                  mid: 7,
                  name: 'UP主A',
                },
              },
              {
                bvid: 'BV_SYNC_2',
                title: 'float3 和向量',
                duration: 300,
                ctime: 1710000200,
                fav_time: 1710000300,
                upper: {
                  mid: 8,
                  name: 'UP主B',
                },
              },
            ],
          },
        });
      }

      throw new Error(`Unexpected request: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handler!({ limit: '10', delayMs: '0' }, {
      connector: createBilibiliConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });

    expect(result.resultType).toBe('resource');
    expect(result.resourceRef).toBe('resource.bilibili_favorites');
    expect(result.data).toMatchObject({
      platform: 'bilibili',
      syncedAt: '2026-04-20T12:00:00.000Z',
      account: {
        mid: 42,
        uname: '收藏测试账号',
      },
      stats: {
        folders: 1,
        videos: 2,
      },
      indexPath: expect.stringContaining('bilibili-favorites.json'),
    });

    const indexPath = String((result.data as Record<string, unknown>).indexPath);
    const saved = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;

    expect(saved).toMatchObject({
      folders: [
        {
          folderId: '1001',
          title: 'Shader 收藏',
          mediaCount: 2,
        },
      ],
      videos: [
        {
          platform: 'bilibili',
          folderId: '1001',
          folderTitle: 'Shader 收藏',
          bvid: 'BV_SYNC_1',
          url: 'https://www.bilibili.com/video/BV_SYNC_1/',
          title: 'HLSL length 讲解',
          author: 'UP主A',
          duration: 684,
          ingestStatus: 'pending',
          knowledgeVideoId: 'BV_SYNC_1',
        },
        {
          bvid: 'BV_SYNC_2',
          title: 'float3 和向量',
          author: 'UP主B',
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/x/v3/fav/resource/list'),
      expect.objectContaining({
        headers: expect.objectContaining({
          cookie: expect.stringContaining('SESSDATA=fake-session'),
        }),
      }),
    );
  });

  it('writes limited Bilibili syncs to a partial index without overwriting the official index', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-favorites-partial-'));
    const collectionsPath = join(rootPath, '_collections');
    const officialIndexPath = join(collectionsPath, 'bilibili-favorites.json');
    const partialIndexPath = join(collectionsPath, 'bilibili-favorites.partial.json');

    mkdirSync(collectionsPath, { recursive: true });
    writeJson(officialIndexPath, {
      platform: 'bilibili',
      syncedAt: '2026-04-19T00:00:00.000Z',
      videos: [
        {
          bvid: 'BV_EXISTING_FULL',
          title: 'Existing full index',
        },
      ],
      syncOptions: {
        partial: false,
      },
    });

    const registry = createRegistry();
    const handler = registry.getHandler('bilibili.favorites.sync');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const href = String(url);

      if (href.includes('/x/web-interface/nav')) {
        return Response.json({
          code: 0,
          data: {
            isLogin: true,
            mid: 42,
            uname: '收藏测试账号',
          },
        });
      }

      if (href.includes('/x/v3/fav/folder/created/list-all')) {
        return Response.json({
          code: 0,
          data: {
            list: [
              {
                media_id: 1001,
                title: 'Shader 收藏',
                media_count: 3,
              },
            ],
          },
        });
      }

      if (href.includes('/x/v3/fav/resource/list')) {
        return Response.json({
          code: 0,
          data: {
            medias: [
              {
                bvid: 'BV_PARTIAL_1',
                title: 'Partial sync first item',
                upper: {
                  name: 'UP主A',
                },
              },
              {
                bvid: 'BV_PARTIAL_2',
                title: 'Partial sync second item',
                upper: {
                  name: 'UP主B',
                },
              },
            ],
          },
        });
      }

      throw new Error(`Unexpected request: ${href}`);
    }));

    const result = await handler!({ limit: '1', delayMs: '0' }, {
      connector: createBilibiliConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });

    expect(result.data).toMatchObject({
      indexPath: partialIndexPath,
      officialIndexPath,
      partialIndexPath,
      committed: false,
      syncOptions: {
        partial: true,
      },
    });
    expect(JSON.parse(readFileSync(officialIndexPath, 'utf8'))).toMatchObject({
      videos: [
        {
          bvid: 'BV_EXISTING_FULL',
        },
      ],
    });
    expect(existsSync(partialIndexPath)).toBe(true);
    expect(JSON.parse(readFileSync(partialIndexPath, 'utf8'))).toMatchObject({
      videos: [
        {
          bvid: 'BV_PARTIAL_1',
        },
      ],
      syncOptions: {
        partial: true,
      },
    });
  });

  it('keeps the official Bilibili favorites index when sync fails before completion', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-favorites-failed-'));
    const collectionsPath = join(rootPath, '_collections');
    const officialIndexPath = join(collectionsPath, 'bilibili-favorites.json');

    mkdirSync(collectionsPath, { recursive: true });
    writeJson(officialIndexPath, {
      platform: 'bilibili',
      videos: [
        {
          bvid: 'BV_KEEP_ME',
          title: 'Keep this official index',
        },
      ],
    });

    const registry = createRegistry();
    const handler = registry.getHandler('bilibili.favorites.sync');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const href = String(url);

      if (href.includes('/x/web-interface/nav')) {
        return Response.json({
          code: 0,
          data: {
            isLogin: true,
            mid: 42,
            uname: '收藏测试账号',
          },
        });
      }

      if (href.includes('/x/v3/fav/folder/created/list-all')) {
        return Response.json({
          code: 0,
          data: {
            list: [
              {
                media_id: 1001,
                title: 'Shader 收藏',
                media_count: 3,
              },
            ],
          },
        });
      }

      if (href.includes('/x/v3/fav/resource/list')) {
        return Response.json({
          code: -400,
          message: 'request failed',
          data: {},
        });
      }

      throw new Error(`Unexpected request: ${href}`);
    }));

    await expect(
      handler!({ limit: '10', delayMs: '0' }, {
        connector: createBilibiliConnector(rootPath),
        now: () => '2026-04-20T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({
      code: 'connector_unavailable',
    });
    expect(JSON.parse(readFileSync(officialIndexPath, 'utf8'))).toMatchObject({
      videos: [
        {
          bvid: 'BV_KEEP_ME',
        },
      ],
    });
  });

  it('writes a Bilibili favorites resume cache before surfacing a later folder failure', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-favorites-cache-fail-'));
    const cachePath = join(rootPath, '_collections', 'bilibili-favorites.sync-cache.json');
    const registry = createRegistry();
    const handler = registry.getHandler('bilibili.favorites.sync');

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const href = String(url);

      if (href.includes('/x/web-interface/nav')) {
        return Response.json({
          code: 0,
          data: {
            isLogin: true,
            mid: 42,
            uname: '收藏测试账号',
          },
        });
      }

      if (href.includes('/x/v3/fav/folder/created/list-all')) {
        return Response.json({
          code: 0,
          data: {
            list: [
              {
                media_id: 1001,
                title: 'Shader 收藏',
                media_count: 1,
              },
              {
                media_id: 1002,
                title: '失败收藏',
                media_count: 1,
              },
            ],
          },
        });
      }

      if (href.includes('/x/v3/fav/resource/list')) {
        const mediaId = new URL(href).searchParams.get('media_id');

        if (mediaId === '1001') {
          return Response.json({
            code: 0,
            data: {
              medias: [
                {
                  bvid: 'BV_CACHE_1',
                  title: 'Cached before failure',
                  upper: {
                    name: 'UP主A',
                  },
                },
              ],
            },
          });
        }

        return Response.json({
          code: -400,
          message: 'request failed',
          data: {},
        });
      }

      throw new Error(`Unexpected request: ${href}`);
    }));

    await expect(
      handler!({ limit: '10', delayMs: '0', resume: 'true' }, {
        connector: createBilibiliConnector(rootPath),
        now: () => '2026-04-20T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({
      code: 'connector_unavailable',
    });

    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toMatchObject({
      platform: 'bilibili',
      account: {
        mid: 42,
      },
      folders: [
        {
          folderId: '1001',
          title: 'Shader 收藏',
        },
        {
          folderId: '1002',
          title: '失败收藏',
        },
      ],
      folderPages: {
        '1001': {
          complete: true,
          pages: {
            '1': [
              {
                bvid: 'BV_CACHE_1',
                title: 'Cached before failure',
              },
            ],
          },
        },
      },
      videos: [
        {
          bvid: 'BV_CACHE_1',
        },
      ],
    });
  });

  it('reuses completed Bilibili favorites cache pages during resume sync', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-favorites-cache-resume-'));
    const collectionsPath = join(rootPath, '_collections');
    const cachePath = join(collectionsPath, 'bilibili-favorites.sync-cache.json');

    mkdirSync(collectionsPath, { recursive: true });
    writeJson(cachePath, {
      platform: 'bilibili',
      updatedAt: '2026-04-20T11:00:00.000Z',
      account: {
        mid: 42,
        uname: '收藏测试账号',
      },
      folders: [
        {
          folderId: '1001',
          title: 'Shader 收藏',
          mediaCount: 2,
        },
      ],
      folderPages: {
        '1001': {
          complete: true,
          pages: {
            '1': [
              {
                platform: 'bilibili',
                folderId: '1001',
                folderTitle: 'Shader 收藏',
                bvid: 'BV_CACHED_1',
                url: 'https://www.bilibili.com/video/BV_CACHED_1/',
                title: 'Cached HLSL length',
                author: 'UP主A',
                ingestStatus: 'pending',
                knowledgeVideoId: 'BV_CACHED_1',
              },
              {
                platform: 'bilibili',
                folderId: '1001',
                folderTitle: 'Shader 收藏',
                bvid: 'BV_CACHED_2',
                url: 'https://www.bilibili.com/video/BV_CACHED_2/',
                title: 'Cached float3',
                author: 'UP主B',
                ingestStatus: 'pending',
                knowledgeVideoId: 'BV_CACHED_2',
              },
            ],
          },
        },
      },
      videos: [
        {
          bvid: 'BV_CACHED_1',
        },
        {
          bvid: 'BV_CACHED_2',
        },
      ],
    });

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);

      if (href.includes('/x/web-interface/nav')) {
        return Response.json({
          code: 0,
          data: {
            isLogin: true,
            mid: 42,
            uname: '收藏测试账号',
          },
        });
      }

      if (href.includes('/x/v3/fav/folder/created/list-all')) {
        return Response.json({
          code: 0,
          data: {
            list: [
              {
                media_id: 1001,
                title: 'Shader 收藏',
                media_count: 2,
              },
            ],
          },
        });
      }

      if (href.includes('/x/v3/fav/resource/list')) {
        throw new Error('resource/list should not be called for a completed cache page');
      }

      throw new Error(`Unexpected request: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = createRegistry();
    const handler = registry.getHandler('bilibili.favorites.sync');
    const result = await handler!({ limit: '10', delayMs: '0', resume: 'true' }, {
      connector: createBilibiliConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });

    expect(result.data).toMatchObject({
      cachePath,
      cache: {
        enabled: true,
        pageHits: 1,
        pageWrites: 0,
      },
      stats: {
        folders: 1,
        videos: 2,
      },
      videos: [
        {
          bvid: 'BV_CACHED_1',
          title: 'Cached HLSL length',
        },
        {
          bvid: 'BV_CACHED_2',
          title: 'Cached float3',
        },
      ],
      committed: true,
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/x/v3/fav/resource/list'),
      expect.anything(),
    );
  });

  it('fails Bilibili favorites sync with an auth-required error when no cookie is configured', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'video-favorites-no-auth-'));
    const registry = createRegistry();
    const handler = registry.getHandler('bilibili.favorites.sync');

    await expect(
      handler!({}, {
        connector: createVideoConnector(rootPath),
        now: () => '2026-04-20T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({
      code: 'connector_unavailable',
      details: {
        reason: 'auth_required',
      },
    });
  });

  it('searches video operation notes, timelines, and transcript evidence', async () => {
    const rootPath = createVideoRoot();
    const registry = createRegistry();
    const handler = registry.getHandler('video.knowledge.search');

    const result = await handler!({ query: 'float length' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });

    expect(result.resultType).toBe('resource_list');
    expect(result.resourceRef).toBe('resource.video_knowledge');
    expect(result.data).toMatchObject({
      items: [
        expect.objectContaining({
          videoId: 'BV_TEST',
          title: '平台标题不准确',
          sourceUrl: 'https://www.bilibili.com/video/BV_TEST/',
          signalProfile: expect.objectContaining({
            primary_signal: 'visual',
          }),
          matches: expect.arrayContaining([
            expect.objectContaining({
              kind: 'operation_note',
              title: expect.stringContaining('float'),
              evidenceRanges: ['07:30-08:45'],
            }),
            expect.objectContaining({
              kind: 'transcript',
              title: 'Transcript hit',
            }),
          ]),
          evidence: expect.objectContaining({
            screenshots: expect.arrayContaining([
              expect.objectContaining({
                time: '08:15',
                path: expect.stringContaining('shot-000815.png'),
              }),
            ]),
            transcriptPath: expect.stringContaining('transcript.txt'),
          }),
        }),
      ],
    });
  });

  it('returns a complete video evidence bundle by video id', async () => {
    const rootPath = createVideoRoot();
    const registry = createRegistry();
    const handler = registry.getHandler('video.knowledge.get');

    const result = await handler!({ videoId: 'BV_TEST' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });

    expect(result.resultType).toBe('resource');
    expect(result.resourceRef).toBe('resource.video_knowledge');
    expect(result.data).toMatchObject({
      video: expect.objectContaining({
        videoId: 'BV_TEST',
        title: '平台标题不准确',
        agentUsage: expect.objectContaining({
          can_answer_how_to: true,
          safe_to_quote_exact_code: false,
        }),
        operationNotes: expect.arrayContaining([
          expect.objectContaining({
            title: '在 Niagara 中计算两点距离',
            evidence_ranges: ['04:30-06:00'],
          }),
        ]),
        keyScreenshots: expect.arrayContaining([
          expect.objectContaining({
            time: '08:15',
            path: expect.stringContaining('shot-000815.png'),
          }),
        ]),
        transcript: expect.objectContaining({
          path: expect.stringContaining('transcript.txt'),
          preview: expect.arrayContaining([
            expect.stringContaining('too many parameters'),
          ]),
        }),
        paths: expect.objectContaining({
          reportPath: expect.stringContaining('video-report.md'),
          evidencePath: expect.stringContaining('video-evidence.md'),
          documentManifestPath: expect.stringContaining('video-document-manifest.json'),
        }),
      }),
    });
  });

  it('checks processed video status and returns verified report paths', async () => {
    const rootPath = createVideoRoot();
    const registry = createRegistry();
    const handler = registry.getHandler('video.knowledge.check');

    const result = await handler!({ videoId: 'BV_TEST' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });

    expect(result).toMatchObject({
      resultType: 'resource',
      resourceRef: 'resource.video_knowledge_status',
      data: {
        ok: true,
        status: 'processed',
        videoId: 'BV_TEST',
        title: '平台标题不准确',
        paths: {
          reportPath: expect.stringContaining('video-report.md'),
          evidencePath: expect.stringContaining('video-evidence.md'),
          documentManifestPath: expect.stringContaining('video-document-manifest.json'),
          documentAssetsDir: expect.stringContaining('document-assets'),
        },
        transcript: {
          exists: true,
          path: expect.stringContaining('asr'),
          lineCount: 3,
        },
        keyframeSelection: {
          preset: 'semantic-tight',
          source: 'keyframe_manifest',
          manifestPath: expect.stringContaining('semantic-tight-keyframes.manifest.json'),
          algorithm: 'hybrid_visual_cluster_plus_timeline_coverage_and_semantic_scoring',
          selectedCount: 17,
          semanticMinScore: 0.8,
          semanticWindowSeconds: 10,
          maxFramesPerMinute: 3,
          answerFields: {
            selectedCount: 17,
            'semantic-min-score': 0.8,
            'max-frames-per-minute': 3,
            'semantic-window-seconds': 10,
            'keyframe manifest path': expect.stringContaining('semantic-tight-keyframes.manifest.json'),
          },
        },
      },
      nextCapabilities: ['video.knowledge.get'],
    });
  });

  it('does not mark a processed report as ok when its transcript is an error traceback', async () => {
    const rootPath = createVideoRoot();
    const videoPath = join(rootPath, 'BV_BAD_TRANSCRIPT');
    const transcriptTextPath = join(videoPath, 'asr', 'transcript.txt');

    mkdirSync(join(videoPath, 'asr'), { recursive: true });
    mkdirSync(join(videoPath, 'document-assets'), { recursive: true });
    writeFileSync(join(videoPath, 'document-assets', 'frame-0000.png'), 'fake image bytes', 'utf8');
    writeFileSync(transcriptTextPath, 'Traceback (most recent call last):\nhttpx.RemoteProtocolError: Server disconnected\n', 'utf8');
    writeJson(join(videoPath, 'qwen-style-video-analysis-bundle.json'), {
      video_id: 'BV_BAD_TRANSCRIPT',
      source_url: 'https://www.bilibili.com/video/BV_BAD_TRANSCRIPT/',
      platform_title: 'UE5材质报告',
      computed_title: 'UE5 Material Report',
      operation_notes: [
        {
          title: 'UE5材质报告',
          purpose: '视觉证据存在。',
          evidence_ranges: ['00:00-00:30'],
        },
      ],
    });
    writeFileSync(join(videoPath, 'video-report.md'), '# UE5材质报告\n', 'utf8');
    writeFileSync(join(videoPath, 'video-evidence.md'), '# UE5材质报告 证据\n', 'utf8');
    writeJson(join(videoPath, 'video-document-manifest.json'), {
      videoId: 'BV_BAD_TRANSCRIPT',
      reportPath: join(videoPath, 'video-report.md'),
      evidencePath: join(videoPath, 'video-evidence.md'),
      transcriptTextPath,
      assetsDirectory: join(videoPath, 'document-assets'),
    });

    const registry = createRegistry();
    const handler = registry.getHandler('video.knowledge.check');
    const result = await handler!({ videoId: 'BV_BAD_TRANSCRIPT' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });

    expect(result).toMatchObject({
      resultType: 'resource',
      resourceRef: 'resource.video_knowledge_status',
      data: {
        ok: false,
        status: 'processed_invalid_transcript',
        videoId: 'BV_BAD_TRANSCRIPT',
        transcript: {
          exists: false,
          path: transcriptTextPath,
          invalid: true,
          invalidReason: 'error_traceback',
        },
        qualityWarnings: expect.arrayContaining([
          expect.stringContaining('transcript'),
        ]),
      },
      nextCapabilities: ['video.ingest.transcribe-local'],
    });
  });

  it('checks missing video status without constructing report paths', async () => {
    const rootPath = createVideoRoot();
    const registry = createRegistry();
    const handler = registry.getHandler('video.knowledge.check');

    const result = await handler!({ videoId: 'BV_MISSING' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });

    expect(result).toMatchObject({
      resultType: 'resource',
      resourceRef: 'resource.video_knowledge_status',
      data: {
        ok: false,
        status: 'not_processed',
        videoId: 'BV_MISSING',
        guidance: expect.stringContaining('Do not summarize it'),
      },
      nextCapabilities: ['video.ingest.enqueue'],
    });
    expect(result.data).not.toHaveProperty('paths');
  });

  it('reports partial video artifacts as in progress and not processed', async () => {
    const rootPath = createPartialVideoRoot();
    const registry = createRegistry();
    const handler = registry.getHandler('video.knowledge.check');

    const result = await handler!({ videoId: 'BV_PARTIAL' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });

    expect(result).toMatchObject({
      resultType: 'resource',
      resourceRef: 'resource.video_knowledge_status',
      data: {
        ok: false,
        status: 'in_progress',
        stage: 'transcribed',
        videoId: 'BV_PARTIAL',
        partialEvidence: {
          transcriptPath: expect.stringContaining('transcript.txt'),
          screenshotCount: 1,
        },
        guidance: expect.stringContaining('no complete video-report.md/video-evidence.md'),
      },
    });
    expect(result.data).not.toHaveProperty('paths');
  });

  it('does not return partial artifacts as a processed evidence bundle', async () => {
    const rootPath = createPartialVideoRoot();
    const registry = createRegistry();
    const handler = registry.getHandler('video.knowledge.get');

    await expect(handler!({ videoId: 'BV_PARTIAL' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    })).rejects.toMatchObject({
      code: 'resource_not_found',
      details: {
        videoId: 'BV_PARTIAL',
        status: 'in_progress',
        stage: 'transcribed',
      },
    });
  });

  it('does not search partial artifacts as processed video knowledge', async () => {
    const rootPath = createPartialVideoRoot();
    const registry = createRegistry();
    const handler = registry.getHandler('video.knowledge.search');

    const result = await handler!({ query: '转录' }, {
      connector: createVideoConnector(rootPath),
      now: () => '2026-04-20T12:00:00.000Z',
    });

    expect(result).toMatchObject({
      resultType: 'resource_list',
      resourceRef: 'resource.video_knowledge',
      data: {
        items: [],
      },
    });
  });
});

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../executor/app-error.js';
import { firstString, normalizeInput, parseBoolean } from './common.js';
import { resolveConfiguredPath } from './paths.js';
import type { VideoKnowledgeConnector } from './types.js';

export type VideoKnowledgeEnvironmentRequirement =
  | {
      kind: 'binary';
      name: string;
      command: string;
      versionArgs?: string[];
      installHint?: string;
    }
  | {
      kind: 'file';
      name: string;
      path: string | undefined;
      installHint?: string;
    };

type VideoKnowledgeEnvironmentCheck = {
  name: string;
  kind: 'binary' | 'file';
  required: true;
  ok: boolean;
  command?: string;
  path?: string;
  realPath?: string;
  version?: string;
  code?: string;
  severity?: 'error' | 'warning';
  message?: string;
  installHint?: string;
};

function getConfiguredBinary(connector: VideoKnowledgeConnector, key: string, fallback: string): string {
  return normalizeInput(connector.config?.[key]) || fallback;
}

function getDefaultPythonCommand(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function firstOutputLine(value: unknown): string | undefined {
  const text = normalizeInput(value);
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function isTransientExecutablePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();

  return normalized.startsWith('/tmp/')
    || normalized.includes('/tmp/')
    || normalized.startsWith('/var/tmp/')
    || normalized.includes('/var/tmp/')
    || normalized.includes('/appdata/local/temp/')
    || normalized.includes('/windows/temp/');
}

function resolveExecutablePath(command: string): string | undefined {
  if (hasPathSeparator(command)) {
    return existsSync(command) ? command : undefined;
  }

  const result = process.platform === 'win32'
    ? spawnSync('where.exe', [command], { encoding: 'utf8', timeout: 5000 })
    : spawnSync('sh', ['-lc', `command -v ${shellQuote(command)}`], { encoding: 'utf8', timeout: 5000 });

  if (result.error || result.status !== 0) {
    return undefined;
  }

  return firstOutputLine(result.stdout);
}

function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function getBinaryVersion(commandOrPath: string, versionArgs: string[] | undefined): string | undefined {
  const args = versionArgs ?? ['--version'];
  const result = spawnSync(commandOrPath, args, {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  });

  return firstOutputLine(result.stdout) ?? firstOutputLine(result.stderr);
}

function checkBinaryRequirement(
  requirement: Extract<VideoKnowledgeEnvironmentRequirement, { kind: 'binary' }>,
  options: { strict: boolean },
): VideoKnowledgeEnvironmentCheck {
  const resolvedPath = resolveExecutablePath(requirement.command);

  if (!resolvedPath) {
    return {
      name: requirement.name,
      kind: 'binary',
      required: true,
      ok: false,
      command: requirement.command,
      code: 'missing_binary',
      severity: 'error',
      message: `${requirement.name} is required but was not found on PATH or at the configured path.`,
      installHint: requirement.installHint,
    };
  }

  const realPath = resolveRealPath(resolvedPath);

  if (options.strict && (isTransientExecutablePath(resolvedPath) || isTransientExecutablePath(realPath))) {
    return {
      name: requirement.name,
      kind: 'binary',
      required: true,
      ok: false,
      command: requirement.command,
      path: resolvedPath,
      ...(realPath !== resolvedPath ? { realPath } : {}),
      code: 'unstable_binary_path',
      severity: 'error',
      message: `${requirement.name} resolves to a transient temp path. Install or configure a durable path before batch ingestion.`,
      installHint: requirement.installHint,
    };
  }

  return {
    name: requirement.name,
    kind: 'binary',
    required: true,
    ok: true,
    command: requirement.command,
    path: resolvedPath,
    ...(realPath !== resolvedPath ? { realPath } : {}),
    version: getBinaryVersion(resolvedPath, requirement.versionArgs),
  };
}

function checkFileRequirement(
  requirement: Extract<VideoKnowledgeEnvironmentRequirement, { kind: 'file' }>,
): VideoKnowledgeEnvironmentCheck {
  if (!requirement.path || !existsSync(requirement.path)) {
    return {
      name: requirement.name,
      kind: 'file',
      required: true,
      ok: false,
      path: requirement.path,
      code: 'missing_file',
      severity: 'error',
      message: `${requirement.name} is required but the configured file was not found.`,
      installHint: requirement.installHint,
    };
  }

  return {
    name: requirement.name,
    kind: 'file',
    required: true,
    ok: true,
    path: requirement.path,
  };
}

export function checkVideoKnowledgeEnvironmentRequirements(
  connector: VideoKnowledgeConnector,
  requirements: VideoKnowledgeEnvironmentRequirement[],
  options: {
    scope: string;
    strict?: boolean;
  },
): Record<string, unknown> {
  const strict = Boolean(options.strict);
  const uniqueRequirements = Array.from(new Map(requirements.map((requirement) => {
    const key = requirement.kind === 'binary'
      ? `${requirement.kind}:${requirement.name}:${requirement.command}`
      : `${requirement.kind}:${requirement.name}:${requirement.path ?? ''}`;
    return [key, requirement] as const;
  })).values());
  const checks = uniqueRequirements.map((requirement) => (
    requirement.kind === 'binary'
      ? checkBinaryRequirement(requirement, { strict })
      : checkFileRequirement(requirement)
  ));
  const problems = checks.filter((check) => !check.ok);

  return {
    ok: problems.length === 0,
    status: problems.length === 0 ? 'ready' : 'blocked',
    mode: 'native-api',
    scope: options.scope,
    strict,
    missing: problems.map((problem) => problem.name),
    problemCodes: [...new Set(problems.map((problem) => problem.code).filter(Boolean))],
    checks,
    guidance: problems.length === 0
      ? 'Environment preflight passed. It is safe to run the requested video pipeline stage.'
      : 'Stop before processing. Fix the missing or unstable prerequisites; do not install tools ad hoc in the middle of an agent run.',
  };
}

export function assertVideoKnowledgeEnvironmentRequirements(
  connector: VideoKnowledgeConnector,
  requirements: VideoKnowledgeEnvironmentRequirement[],
  options: {
    scope: string;
    strict?: boolean;
    stage: string;
  },
): Record<string, unknown> {
  const environment = checkVideoKnowledgeEnvironmentRequirements(connector, requirements, {
    scope: options.scope,
    strict: options.strict,
  });

  if (environment.ok !== true) {
    throw new AppError('connector_unavailable', `Video pipeline environment preflight failed at ${options.stage}.`, {
      details: {
        stage: options.stage,
        environment,
      },
    });
  }

  return environment;
}

function getTranscriptionScriptPath(input: Record<string, unknown>, connector: VideoKnowledgeConnector): string | undefined {
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

function getVisualAnalysisScriptPath(input: Record<string, unknown>, connector: VideoKnowledgeConnector): string | undefined {
  const configured = firstString(
    input.visualAnalysisScriptPath,
    input.scriptPath,
    connector.config?.visualAnalysisScriptPath,
    process.env.VIDEO_KNOWLEDGE_VISUAL_ANALYSIS_SCRIPT,
  );

  return configured ? resolveConfiguredPath(configured) : undefined;
}

function getKeyframeSelectorScriptPath(input: Record<string, unknown>, connector: VideoKnowledgeConnector): string | undefined {
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

function getPythonPath(input: Record<string, unknown>, connector: VideoKnowledgeConnector): string {
  return firstString(
    input.pythonPath,
    connector.config?.pythonPath,
    process.env.VIDEO_KNOWLEDGE_PYTHON,
  ) ?? getDefaultPythonCommand();
}

function getTranscriptProvider(input: Record<string, unknown>, connector: VideoKnowledgeConnector): string {
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

  if (scriptPath.includes('kimi')) {
    return 'kimi';
  }

  if (scriptPath.includes('gemini')) {
    return 'gemini';
  }

  return scriptPath ? 'api' : 'gemini';
}

export function buildCaptureEnvironmentRequirements(
  input: Record<string, unknown>,
  connector: VideoKnowledgeConnector,
): VideoKnowledgeEnvironmentRequirement[] {
  const requirements: VideoKnowledgeEnvironmentRequirement[] = [];

  if (parseBoolean(input.download, true)) {
    requirements.push({
      kind: 'binary',
      name: 'yt-dlp',
      command: getConfiguredBinary(connector, 'ytDlpPath', 'yt-dlp'),
      installHint: 'Install yt-dlp in the project runtime, or set connector.config.ytDlpPath to a durable executable path.',
    });
  }

  if (parseBoolean(input.probe, true)) {
    requirements.push({
      kind: 'binary',
      name: 'ffprobe',
      command: getConfiguredBinary(connector, 'ffprobePath', 'ffprobe'),
      installHint: 'Install FFmpeg/ffprobe in the project runtime, or set connector.config.ffprobePath.',
    });
  }

  if (parseBoolean(input.keyframes, true)) {
    requirements.push({
      kind: 'binary',
      name: 'ffmpeg',
      command: getConfiguredBinary(connector, 'ffmpegPath', 'ffmpeg'),
      installHint: 'Install FFmpeg in a durable project/runtime location, or set connector.config.ffmpegPath.',
    });
  }

  return requirements;
}

export function buildTranscriptionEnvironmentRequirements(
  input: Record<string, unknown>,
  connector: VideoKnowledgeConnector,
): VideoKnowledgeEnvironmentRequirement[] {
  const provider = getTranscriptProvider(input, connector);

  if (provider === 'whisper') {
    const scriptPath = getTranscriptionScriptPath(input, connector);
    // If a Python script is configured (e.g. faster-whisper wrapper), check python + script
    // instead of the OpenAI whisper CLI binary.
    if (scriptPath && scriptPath.toLowerCase().endsWith('.py')) {
      return [
        {
          kind: 'binary',
          name: 'python',
          command: getPythonPath(input, connector),
          versionArgs: ['--version'],
          installHint: 'Configure connector.config.pythonPath or VIDEO_KNOWLEDGE_PYTHON to the Python runtime used by the video scripts.',
        },
        {
          kind: 'file',
          name: 'transcriptionScriptPath',
          path: scriptPath,
          installHint: 'Keep skills/video-knowledge/scripts/transcribe_audio_whisper.py (or another whisper-wrapping Python script) available, or configure transcriptionScriptPath.',
        },
      ];
    }
    return parseBoolean(input.whisper, true)
      ? [{
          kind: 'binary',
          name: 'whisper',
          command: getConfiguredBinary(connector, 'whisperPath', 'whisper'),
          installHint: 'Install openai-whisper in the project runtime, or use provider=gemini/kimi/api, or configure transcriptionScriptPath to a .py wrapper.',
        }]
      : [];
  }

  return [
    {
      kind: 'binary',
      name: 'python',
      command: getPythonPath(input, connector),
      versionArgs: ['--version'],
      installHint: 'Configure connector.config.pythonPath or VIDEO_KNOWLEDGE_PYTHON to the Python runtime used by the video scripts.',
    },
    {
      kind: 'file',
      name: 'transcriptionScriptPath',
      path: getTranscriptionScriptPath(input, connector),
      installHint: 'Keep skills/video-knowledge/scripts/transcribe_audio_gemini.py available, or configure transcriptionScriptPath.',
    },
  ];
}

export function buildVisualEnvironmentRequirements(
  input: Record<string, unknown>,
  connector: VideoKnowledgeConnector,
): VideoKnowledgeEnvironmentRequirement[] {
  return [
    {
      kind: 'binary',
      name: 'python',
      command: getPythonPath(input, connector),
      versionArgs: ['--version'],
      installHint: 'Configure connector.config.pythonPath or VIDEO_KNOWLEDGE_PYTHON to the Python runtime used by the video scripts.',
    },
    {
      kind: 'file',
      name: 'visualAnalysisScriptPath',
      path: getVisualAnalysisScriptPath(input, connector),
      installHint: 'Configure connector.config.visualAnalysisScriptPath or pass --script-path before visual analysis.',
    },
  ];
}

export function buildDocumentEnvironmentRequirements(
  input: Record<string, unknown>,
  connector: VideoKnowledgeConnector,
): VideoKnowledgeEnvironmentRequirement[] {
  if (!parseBoolean(input.autoKeyframeSelection, true)) {
    return [];
  }

  return [
    {
      kind: 'binary',
      name: 'python',
      command: getPythonPath(input, connector),
      versionArgs: ['--version'],
      installHint: 'Configure connector.config.pythonPath or VIDEO_KNOWLEDGE_PYTHON to the Python runtime used by the video scripts.',
    },
    {
      kind: 'binary',
      name: 'ffmpeg',
      command: getConfiguredBinary(connector, 'ffmpegPath', 'ffmpeg'),
      installHint: 'Install FFmpeg in a durable project/runtime location, or set connector.config.ffmpegPath.',
    },
    {
      kind: 'file',
      name: 'keyframeSelectorScriptPath',
      path: getKeyframeSelectorScriptPath(input, connector),
      installHint: 'Keep skills/video-knowledge/scripts/select_keyframes.py available, or configure keyframeSelectorScriptPath.',
    },
  ];
}

export function checkVideoKnowledgeEnvironment(
  input: Record<string, unknown>,
  connector: VideoKnowledgeConnector,
): Record<string, unknown> {
  const scope = normalizeInput(input.scope).toLowerCase() || 'full';
  const strict = parseBoolean(input.strict, false);
  const requirements: VideoKnowledgeEnvironmentRequirement[] = [];

  if (['full', 'capture', 'download'].includes(scope)) {
    requirements.push(...buildCaptureEnvironmentRequirements(input, connector));
  }

  if (['full', 'transcribe', 'transcription', 'asr'].includes(scope)) {
    requirements.push(...buildTranscriptionEnvironmentRequirements(input, connector));
  }

  if (['full', 'visual', 'vision', 'analyze'].includes(scope)) {
    requirements.push(...buildVisualEnvironmentRequirements(input, connector));
  }

  if (['full', 'document', 'compose-document'].includes(scope)) {
    requirements.push(...buildDocumentEnvironmentRequirements(input, connector));
  }

  return checkVideoKnowledgeEnvironmentRequirements(connector, requirements, {
    scope,
    strict,
  });
}

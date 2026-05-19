import { asString, firstString, isUsableTranscriptText, readTextFile } from './common.js';
import type { SearchMatch, VideoKnowledgeRecord } from './types.js';

export function getQueryTerms(query: string): string[] {
  const normalizedQuery = query.toLowerCase().trim();
  const terms = normalizedQuery.split(/[\s,，。:：;；/\\|]+/).filter(Boolean);

  if (terms.includes(normalizedQuery) || !normalizedQuery) {
    return terms;
  }

  return [normalizedQuery, ...terms];
}

export function includesQuery(value: unknown, query: string): boolean {
  const haystack = JSON.stringify(value).toLowerCase();
  const terms = getQueryTerms(query);

  return terms.some((term) => haystack.includes(term));
}

export function getTranscriptPreview(transcriptText: string | undefined, query?: string): string[] {
  if (!isUsableTranscriptText(transcriptText)) {
    return [];
  }

  const lines = transcriptText!
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!query) {
    return lines.slice(0, 24);
  }

  const normalizedQuery = query.toLowerCase();
  const terms = getQueryTerms(query);
  const hits = lines.filter((line) => {
    const normalizedLine = line.toLowerCase();
    return normalizedLine.includes(normalizedQuery) || terms.some((term) => normalizedLine.includes(term));
  });

  // When a query is provided, return only real hits. Falling back to the
  // first N lines made every video with a transcript appear to "match",
  // which broke search relevance.
  return hits.slice(0, 12);
}

export function toSearchMatches(video: VideoKnowledgeRecord, query: string): SearchMatch[] {
  const matches: SearchMatch[] = [];

  for (const note of video.operationNotes) {
    if (!includesQuery(note, query)) {
      continue;
    }

    matches.push({
      kind: 'operation_note',
      title: asString(note.title) ?? 'Operation note',
      summary: asString(note.purpose),
      evidenceRanges: note.evidence_ranges,
      confidence: note.confidence,
    });
  }

  for (const segment of video.timelineSegments) {
    if (!includesQuery(segment, query)) {
      continue;
    }

    matches.push({
      kind: 'timeline',
      title: asString(segment.topic) ?? 'Timeline segment',
      summary: asString(segment.summary),
      evidenceRanges: [segment.start, segment.end].filter(Boolean),
    });
  }

  for (const term of video.visibleTextEvidence) {
    if (!includesQuery(term, query)) {
      continue;
    }

    matches.push({
      kind: 'visible_text',
      title: asString(term.term) ?? 'Visible text',
      summary: asString(term.meaning),
      evidenceRanges: term.evidence_ranges,
      confidence: term.confidence,
    });
  }

  for (const formula of video.formulaOrCodeCandidates) {
    if (!includesQuery(formula, query)) {
      continue;
    }

    matches.push({
      kind: 'formula',
      title: asString(formula.text) ?? 'Formula/code candidate',
      summary: asString(formula.interpretation),
      evidenceRanges: formula.evidence_ranges,
      confidence: formula.confidence,
    });
  }

  for (const gotcha of video.gotchas) {
    if (!includesQuery(gotcha, query)) {
      continue;
    }

    matches.push({
      kind: 'gotcha',
      title: asString(gotcha.title) ?? 'Gotcha',
      summary: firstString(gotcha.symptom, gotcha.fix_or_check),
      evidenceRanges: gotcha.evidence_ranges,
      confidence: gotcha.confidence,
    });
  }

  const transcriptHits = getTranscriptPreview(readTextFile(video.transcript.path ?? ''), query);

  if (transcriptHits.length > 0) {
    matches.push({
      kind: 'transcript',
      title: 'Transcript hit',
      summary: transcriptHits.slice(0, 3).join('\n'),
    });
  }

  return matches;
}

export function toSearchResult(video: VideoKnowledgeRecord, matches: SearchMatch[]): Record<string, unknown> {
  return {
    videoId: video.videoId,
    title: video.title,
    sourceUrl: video.sourceUrl,
    uploader: video.uploader,
    durationSeconds: video.durationSeconds,
    signalProfile: video.signalProfile,
    videoValue: video.videoValue,
    agentUsage: video.agentUsage,
    matches: matches.slice(0, 12),
    evidence: {
      screenshots: video.keyScreenshots.slice(0, 6),
      transcriptPath: video.transcript.path,
      safeToQuoteExactCode: video.agentUsage?.safe_to_quote_exact_code,
    },
  };
}

export function findVideoById(videos: VideoKnowledgeRecord[], videoId: string): VideoKnowledgeRecord | undefined {
  return videos.find((video) => video.videoId === videoId);
}

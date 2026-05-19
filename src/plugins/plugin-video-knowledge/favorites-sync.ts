import type { PluginHandlerContext } from '../../contracts/index.js';
import { AppError } from '../../executor/app-error.js';
import {
  bilibiliData,
  fetchBilibiliAccount,
  fetchBilibiliFavoriteFolders,
  fetchBilibiliJson,
} from './bilibili-api.js';
import {
  asObject,
  asObjectArray,
  asString,
  firstString,
  getMutableObjectProperty,
  parseBoolean,
  parseDelayMs,
  parseLimit,
  readJsonObject,
  sleep,
  normalizeInput,
  unixSecondsToIso,
  valueToNumber,
  valueToString,
  writeJsonFileAtomic,
} from './common.js';
import { getBilibiliFavoritesIndexPaths } from './favorites-index.js';
import {
  enrichBilibiliFavoriteVideosWithLocalState,
  writeProcessedVideoIndex,
  writeVideoCatalog,
} from './local-video-index.js';
import { getBilibiliCookie } from './paths.js';
import type { BilibiliFavoritesCacheState, VideoKnowledgeConnector } from './types.js';

export function getCachedBilibiliPage(
  cache: Record<string, unknown>,
  folderId: string,
  pageNumber: number,
): Array<Record<string, unknown>> | undefined {
  const folderPages = asObject(cache.folderPages);
  const folderCache = asObject(folderPages?.[folderId]);
  const pages = asObject(folderCache?.pages);
  const page = pages?.[String(pageNumber)];

  return Array.isArray(page)
    ? page.filter((entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : undefined;
}

export function setCachedBilibiliPage(
  cache: Record<string, unknown>,
  folderId: string,
  pageNumber: number,
  videos: Array<Record<string, unknown>>,
  complete: boolean,
): void {
  const folderPages = getMutableObjectProperty(cache, 'folderPages');
  const folderCache = getMutableObjectProperty(folderPages, folderId);
  const pages = getMutableObjectProperty(folderCache, 'pages');

  pages[String(pageNumber)] = videos;
  if (complete) {
    folderCache.complete = true;
  }
}

export function flattenCachedBilibiliVideos(cache: Record<string, unknown>): Array<Record<string, unknown>> {
  const folderPages = asObject(cache.folderPages);

  if (!folderPages) {
    return [];
  }

  const folders = asObjectArray(cache.folders);
  const folderIds = folders.length > 0
    ? folders.map((folder) => asString(folder.folderId)).filter((folderId): folderId is string => Boolean(folderId))
    : Object.keys(folderPages);
  const videos: Array<Record<string, unknown>> = [];

  for (const folderId of folderIds) {
    const folderCache = asObject(folderPages[folderId]);
    const pages = asObject(folderCache?.pages);

    if (!pages) {
      continue;
    }

    for (const pageNumber of Object.keys(pages).sort((left, right) => Number(left) - Number(right))) {
      videos.push(...asObjectArray(pages[pageNumber]));
    }
  }

  return videos;
}

export function writeBilibiliFavoritesSyncCache(state: BilibiliFavoritesCacheState): void {
  if (!state.enabled) {
    return;
  }

  state.cache.platform = 'bilibili';
  state.cache.updatedAt = state.now();
  state.cache.account = state.account;
  state.cache.folders = state.folders;
  state.cache.videos = flattenCachedBilibiliVideos(state.cache);
  writeJsonFileAtomic(state.cachePath, state.cache);
}

export function normalizeBilibiliFolder(folder: Record<string, unknown>): Record<string, unknown> | undefined {
  const folderId = valueToString(folder.media_id) ?? valueToString(folder.id) ?? valueToString(folder.fid);
  const title = firstString(folder.title, folder.name) ?? folderId;

  if (!folderId || !title) {
    return undefined;
  }

  return {
    folderId,
    title,
    mediaCount: valueToNumber(folder.media_count ?? folder.mediaCount) ?? 0,
  };
}

function escapeMarkdownTableCell(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatBilibiliFavoriteFoldersMarkdown(
  account: Record<string, unknown>,
  folders: Array<Record<string, unknown>>,
  mediaCountTotal: number,
  fetchedAt: string,
): string {
  const accountName = asString(account.uname) ?? asString(account.name) ?? 'unknown';
  const rows = folders.map((folder) => {
    const title = escapeMarkdownTableCell(asString(folder.title) ?? asString(folder.folderId) ?? '');
    const mediaCount = valueToNumber(folder.mediaCount) ?? 0;

    return `| ${title} | ${mediaCount} |`;
  });

  return [
    `B站账号 @${escapeMarkdownTableCell(accountName)} 共有 ${folders.length} 个收藏夹，合计 ${mediaCountTotal} 个视频。`,
    '',
    '| 收藏夹 | 数量 |',
    '|--------|-----:|',
    ...rows,
    '',
    `数据取自 B站 live API（${fetchedAt}）。`,
  ].join('\n');
}

export async function listCurrentBilibiliFavoriteFolders(
  input: Record<string, unknown>,
  context: PluginHandlerContext,
): Promise<Record<string, unknown>> {
  const connector = context.connector as VideoKnowledgeConnector;
  const cookieConfig = getBilibiliCookie(connector);

  if (!cookieConfig) {
    throw new AppError('connector_unavailable', 'Bilibili favorite folder listing requires a local login cookie.', {
      details: {
        reason: 'auth_required',
        acceptedSources: ['connector.config.bilibiliCookie', 'connector.config.bilibiliCookieFilePath', 'BILIBILI_COOKIE', 'BILIBILI_COOKIE_FILE'],
      },
      statusCode: 401,
    });
  }

  const requestedFolderId = normalizeInput(input.folderId ?? input.mediaId);
  const account = await fetchBilibiliAccount(cookieConfig.cookie);
  const mid = valueToNumber(account.mid);

  if (!mid) {
    throw new AppError('connector_unavailable', 'Bilibili account response did not include a valid mid.', {
      details: { reason: 'invalid_account_response' },
    });
  }

  const folders = (await fetchBilibiliFavoriteFolders(cookieConfig.cookie, mid))
    .map(normalizeBilibiliFolder)
    .filter((folder): folder is Record<string, unknown> => Boolean(folder))
    .filter((folder) => !requestedFolderId || folder.folderId === requestedFolderId);
  const mediaCountTotal = folders.reduce((sum, folder) => sum + (valueToNumber(folder.mediaCount) ?? 0), 0);
  const fetchedAt = context.now();

  return {
    platform: 'bilibili',
    source: 'live',
    fetchedAt,
    account,
    metadataOnly: true,
    contentEvidence: false,
    folders,
    total: folders.length,
    count: folders.length,
    mediaCountTotal,
    presentation: {
      markdown: formatBilibiliFavoriteFoldersMarkdown(account, folders, mediaCountTotal, fetchedAt),
      rowCount: folders.length,
      mediaCountTotal,
    },
    validation: {
      expectedRows: folders.length,
      expectedMediaCountTotal: mediaCountTotal,
      rule: 'When presenting this result, include every folders[] row and verify the displayed row count and sum.',
    },
    auth: {
      cookieSource: cookieConfig.source,
      cookieStored: false,
    },
  };
}

export function normalizeBilibiliVideo(
  media: Record<string, unknown>,
  folder: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const bvid = firstString(media.bvid, media.bv_id);

  if (!bvid) {
    return undefined;
  }

  const upper = asObject(media.upper);
  const folderId = asString(folder.folderId) ?? '';
  const folderTitle = asString(folder.title) ?? '';

  return {
    platform: 'bilibili',
    folderId,
    folderTitle,
    bvid,
    url: `https://www.bilibili.com/video/${bvid}/`,
    title: firstString(media.title, media.name) ?? bvid,
    author: firstString(upper?.name, media.author, media.upper_name),
    authorId: valueToString(upper?.mid ?? media.upper_mid),
    duration: valueToNumber(media.duration),
    collectedAt: unixSecondsToIso(media.fav_time ?? media.favTime ?? media.mtime),
    publishedAt: unixSecondsToIso(media.ctime ?? media.pubtime),
    cover: asString(media.cover),
    intro: asString(media.intro),
    ingestStatus: 'pending',
    knowledgeVideoId: bvid,
  };
}

async function fetchBilibiliFavoriteVideos(
  cookie: string,
  folder: Record<string, unknown>,
  limit: number,
  delayMs: number,
  cacheState?: BilibiliFavoritesCacheState,
): Promise<Array<Record<string, unknown>>> {
  const folderId = asString(folder.folderId);
  const mediaCount = valueToNumber(folder.mediaCount) ?? 0;

  if (!folderId) {
    return [];
  }

  const videos: Array<Record<string, unknown>> = [];
  const pageSize = 20;
  let pageNumber = 1;

  while (videos.length < limit) {
    let pageVideos: Array<Record<string, unknown>> | undefined;

    if (cacheState?.enabled && !cacheState.forceRefresh) {
      pageVideos = getCachedBilibiliPage(cacheState.cache, folderId, pageNumber);
      if (pageVideos) {
        cacheState.stats.pageHits += 1;
      }
    }

    if (!pageVideos) {
      const data = bilibiliData(
        await fetchBilibiliJson(
          '/x/v3/fav/resource/list',
          {
            media_id: folderId,
            pn: pageNumber,
            ps: pageSize,
            keyword: '',
            order: 'mtime',
            type: 0,
            tid: 0,
            platform: 'web',
          },
          cookie,
        ),
      );
      const medias = asObjectArray(data.medias);

      pageVideos = medias
        .map((media) => normalizeBilibiliVideo(media, folder))
        .filter((normalized): normalized is Record<string, unknown> => Boolean(normalized));

      if (cacheState?.enabled) {
        const totalAfterPage = videos.length + pageVideos.length;
        const complete = mediaCount > 0
          ? totalAfterPage >= mediaCount
          : medias.length < pageSize;

        setCachedBilibiliPage(cacheState.cache, folderId, pageNumber, pageVideos, complete);
        cacheState.stats.pageWrites += 1;
        writeBilibiliFavoritesSyncCache(cacheState);
      }
    }

    for (const video of pageVideos) {
      videos.push(video);
      if (videos.length >= limit) {
        break;
      }
    }

    if (pageVideos.length < pageSize || (mediaCount > 0 && videos.length >= mediaCount)) {
      break;
    }

    pageNumber += 1;
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return videos;
}

export async function syncBilibiliFavorites(
  input: Record<string, unknown>,
  context: PluginHandlerContext,
): Promise<Record<string, unknown>> {
  const connector = context.connector as VideoKnowledgeConnector;
  const cookieConfig = getBilibiliCookie(connector);

  if (!cookieConfig) {
    throw new AppError('connector_unavailable', 'Bilibili favorites sync requires a local login cookie.', {
      details: {
        reason: 'auth_required',
        acceptedSources: ['connector.config.bilibiliCookie', 'connector.config.bilibiliCookieFilePath', 'BILIBILI_COOKIE', 'BILIBILI_COOKIE_FILE'],
      },
      statusCode: 401,
    });
  }

  const { officialIndexPath, partialIndexPath, cachePath } = getBilibiliFavoritesIndexPaths(connector);
  const requestedFolderId = normalizeInput(input.folderId ?? input.mediaId);
  const limit = parseLimit(input.limit, 5000);
  const delayMs = parseDelayMs(input.delayMs, 500);
  const cacheEnabled = parseBoolean(input.cache, true);
  const resume = parseBoolean(input.resume, true);
  const forceRefresh = parseBoolean(input.forceRefresh ?? input.refresh, false);
  const cache = cacheEnabled && resume && !forceRefresh
    ? readJsonObject(cachePath) ?? {}
    : {};
  const cacheStats = {
    pageHits: 0,
    pageWrites: 0,
  };
  const account = await fetchBilibiliAccount(cookieConfig.cookie);
  const mid = valueToNumber(account.mid);

  if (!mid) {
    throw new AppError('connector_unavailable', 'Bilibili account response did not include a valid mid.', {
      details: { reason: 'invalid_account_response' },
    });
  }

  const folders = (await fetchBilibiliFavoriteFolders(cookieConfig.cookie, mid))
    .map(normalizeBilibiliFolder)
    .filter((folder): folder is Record<string, unknown> => Boolean(folder))
    .filter((folder) => !requestedFolderId || folder.folderId === requestedFolderId);
  const videos: Array<Record<string, unknown>> = [];
  const cacheState: BilibiliFavoritesCacheState = {
    enabled: cacheEnabled,
    forceRefresh: forceRefresh || !resume,
    cachePath,
    cache,
    account,
    folders,
    now: context.now,
    stats: cacheStats,
  };

  writeBilibiliFavoritesSyncCache(cacheState);

  for (const folder of folders) {
    const remaining = limit - videos.length;

    if (remaining <= 0) {
      break;
    }

    videos.push(...await fetchBilibiliFavoriteVideos(cookieConfig.cookie, folder, remaining, delayMs, cacheState));
    if (delayMs > 0 && videos.length < limit) {
      await sleep(delayMs);
    }
  }

  const syncedAt = context.now();
  const enrichedVideos = enrichBilibiliFavoriteVideosWithLocalState(videos, connector);
  const processedVideoIndex = writeProcessedVideoIndex(connector, syncedAt);
  const videoCatalog = writeVideoCatalog(connector, videos, syncedAt);
  const index = {
    platform: 'bilibili',
    syncedAt,
    account,
    folders,
    videos: enrichedVideos,
    stats: {
      folders: folders.length,
      videos: videos.length,
      activeFavorites: enrichedVideos.length,
      orphanedVideos: valueToNumber(asObject(videoCatalog.stats)?.orphaned) ?? 0,
      processedOrphanedVideos: valueToNumber(asObject(videoCatalog.stats)?.processedOrphaned) ?? 0,
    },
    auth: {
      cookieSource: cookieConfig.source,
      cookieStored: false,
    },
    syncOptions: {
      limit,
      delayMs,
      resume,
      forceRefresh,
      partial: false,
    },
    lifecycle: {
      processedVideoIndexPath: processedVideoIndex.indexPath,
      videoCatalogPath: videoCatalog.catalogPath,
      processedVideoStats: processedVideoIndex.stats,
      catalogStats: videoCatalog.stats,
      rule: 'Video identity is platform:BV. Favorite folders are mutable current membership, not processing identity.',
    },
  };
  const expectedVideoCount = folders.reduce((sum, folder) => sum + (valueToNumber(folder.mediaCount) ?? 0), 0);
  const partial = videos.length >= limit && (expectedVideoCount === 0 || videos.length < expectedVideoCount);
  const indexPath = partial ? partialIndexPath : officialIndexPath;
  const output = {
    ...index,
    syncOptions: {
      ...index.syncOptions,
      partial,
    },
  };

  writeJsonFileAtomic(indexPath, output);

  return {
    ...output,
    indexPath,
    officialIndexPath,
    partialIndexPath,
    cachePath,
    lifecycle: output.lifecycle,
    cache: {
      enabled: cacheEnabled,
      resume,
      forceRefresh,
      pageHits: cacheStats.pageHits,
      pageWrites: cacheStats.pageWrites,
    },
    committed: !partial,
  };
}

import { AppError } from '../../executor/app-error.js';
import { asObject, asObjectArray, firstString, sleep, valueToNumber } from './common.js';

export const BILIBILI_API_ORIGIN = 'https://api.bilibili.com';

export function getBilibiliHeaders(cookie: string): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    cookie,
    referer: 'https://www.bilibili.com/',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  };
}

export async function fetchBilibiliJson(
  path: string,
  params: Record<string, string | number | undefined>,
  cookie: string,
): Promise<Record<string, unknown>> {
  if (typeof fetch !== 'function') {
    throw new AppError('unsupported_operation', 'The current Node.js runtime does not provide fetch().', {
      details: { reason: 'missing_fetch_runtime' },
      statusCode: 501,
    });
  }

  const url = new URL(path, BILIBILI_API_ORIGIN);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  let response: Response | undefined;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(url.toString(), {
      headers: getBilibiliHeaders(cookie),
    });

    if (response.ok) {
      break;
    }

    const retryable = [408, 409, 412, 425, 429, 500, 502, 503, 504].includes(response.status);
    if (!retryable || attempt === 3) {
      break;
    }

    await sleep((attempt + 1) * 2500);
  }

  if (!response) {
    throw new AppError('connector_unavailable', 'Bilibili API request did not return a response.', {
      details: { path },
    });
  }

  if (!response.ok) {
    throw new AppError('connector_unavailable', `Bilibili API request failed with HTTP ${response.status}.`, {
      details: {
        status: response.status,
        path,
      },
      statusCode: response.status,
    });
  }

  const parsed = await response.json() as unknown;
  const payload = asObject(parsed);

  if (!payload) {
    throw new AppError('connector_unavailable', 'Bilibili API returned a non-object response.', {
      details: { path, reason: 'invalid_response_shape' },
    });
  }

  const code = valueToNumber(payload.code);

  if (code !== 0) {
    throw new AppError('connector_unavailable', 'Bilibili API returned an error.', {
      details: {
        path,
        code: payload.code,
        message: payload.message,
      },
      statusCode: code === -101 ? 401 : 502,
    });
  }

  return payload;
}

export function bilibiliData(payload: Record<string, unknown>): Record<string, unknown> {
  return asObject(payload.data) ?? {};
}

export async function fetchBilibiliAccount(cookie: string): Promise<Record<string, unknown>> {
  const data = bilibiliData(await fetchBilibiliJson('/x/web-interface/nav', {}, cookie));
  const isLogin = data.isLogin === true;
  const mid = valueToNumber(data.mid);

  if (!isLogin || !mid) {
    throw new AppError('connector_unavailable', 'Bilibili login cookie is missing or expired.', {
      details: {
        reason: 'auth_required',
      },
      statusCode: 401,
    });
  }

  return {
    mid,
    uname: firstString(data.uname, data.name),
  };
}

export async function fetchBilibiliFavoriteFolders(cookie: string, mid: number): Promise<Array<Record<string, unknown>>> {
  const data = bilibiliData(await fetchBilibiliJson('/x/v3/fav/folder/created/list-all', { up_mid: mid }, cookie));
  return asObjectArray(data.list);
}

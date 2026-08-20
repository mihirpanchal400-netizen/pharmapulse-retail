/**
 * Typed fetch wrapper for the PharmaPulse API.
 *
 * Responsibilities, deliberately kept in one place:
 *   - attach the bearer token to every request
 *   - unwrap the server's `{ error: { message } }` envelope into a thrown Error
 *     carrying a message that is already safe to show a user
 *   - sign the user out automatically when the token expires (401)
 *
 * Requests go to relative `/api/...` URLs. Vite proxies those to the API on
 * :4000 in development, so there is no base-URL configuration to get wrong and
 * no CORS involved.
 */

const TOKEN_KEY = 'pharmapulse.token';
const USER_KEY = 'pharmapulse.user';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = 'ERROR') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const tokenStore = {
  get: (): string | null => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

export const userStore = {
  get: <T>(): T | null => {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },
  set: (user: unknown) => localStorage.setItem(USER_KEY, JSON.stringify(user)),
};

/** Notified when the server rejects our token, so the app can show the login screen. */
type SessionExpiredHandler = () => void;
let onSessionExpired: SessionExpiredHandler = () => {};
export function setSessionExpiredHandler(handler: SessionExpiredHandler): void {
  onSessionExpired = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Query parameters; undefined, null and '' values are dropped. */
  params?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

function buildUrl(path: string, params?: RequestOptions['params']): string {
  const url = `/api${path.startsWith('/') ? path : `/${path}`}`;
  if (!params) return url;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, params, signal } = options;
  const token = tokenStore.get();

  let response: Response;
  try {
    response = await fetch(buildUrl(path, params), {
      method,
      signal,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // fetch only rejects on a network-level failure - almost always the API
    // process not running. Say that, rather than "Failed to fetch".
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(
      'Cannot reach the PharmaPulse API. Is it running? Start it with  npm run dev',
      0,
      'NETWORK',
    );
  }

  if (response.status === 401) {
    tokenStore.clear();
    onSessionExpired();
    throw new ApiError('Your session has expired. Please sign in again.', 401, 'UNAUTHORIZED');
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let code = 'ERROR';
    try {
      const payload = (await response.json()) as { error?: { message?: string; code?: string } };
      if (payload?.error?.message) message = payload.error.message;
      if (payload?.error?.code) code = payload.error.code;
    } catch {
      // Non-JSON error body - keep the generic message.
    }
    throw new ApiError(message, response.status, code);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, params?: RequestOptions['params'], signal?: AbortSignal) =>
    request<T>(path, { method: 'GET', params, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/**
 * Uploads a spreadsheet to the Import Center.
 *
 * Sent as a raw body with the file name in a header rather than as multipart
 * form data: there is exactly one file, and this keeps the server free of a
 * multipart dependency. `onProgress` is driven by XMLHttpRequest because
 * `fetch` still cannot report upload progress, and a pharmacy uploading a
 * 20 MB product master deserves a progress bar.
 */
export function uploadImportFile<T>(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/imports/upload');
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    // encodeURIComponent keeps a non-ASCII file name inside the header's
    // permitted character set; the server only reads the basename.
    request.setRequestHeader('X-File-Name', encodeURIComponent(file.name));

    const token = tokenStore.get();
    if (token) request.setRequestHeader('Authorization', `Bearer ${token}`);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    request.onload = () => {
      if (request.status === 401) {
        tokenStore.clear();
        onSessionExpired();
        reject(new ApiError('Your session has expired. Please sign in again.', 401, 'UNAUTHORIZED'));
        return;
      }
      try {
        const payload = JSON.parse(request.responseText) as { data?: T; error?: { message?: string; code?: string } };
        if (request.status >= 200 && request.status < 300) {
          resolve(payload.data as T);
        } else {
          reject(new ApiError(payload?.error?.message ?? `Upload failed (${request.status})`, request.status, payload?.error?.code));
        }
      } catch {
        reject(new ApiError(`Upload failed (${request.status})`, request.status));
      }
    };

    request.onerror = () =>
      reject(new ApiError('Cannot reach the PharmaPulse API. Is it running? Start it with  npm run dev', 0, 'NETWORK'));

    request.send(file);
  });
}

/**
 * Downloads any authenticated file endpoint (templates, error reports).
 *
 * Shares the fetch-then-anchor approach with `downloadCsv` below; kept separate
 * because these endpoints are not reports and take no report parameters.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<string> {
  const token = tokenStore.get();
  const response = await fetch(buildUrl(path), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    let message = `Download failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      if (payload?.error?.message) message = payload.error.message;
    } catch {
      /* keep the generic message */
    }
    throw new ApiError(message, response.status);
  }

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filename = /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? fallbackName;

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  return filename;
}

/**
 * Triggers a CSV download.
 *
 * The file has to be fetched rather than linked, because the endpoint needs the
 * Authorization header. The blob is then handed to a temporary anchor so the
 * browser saves it with the filename the server chose.
 */
export async function downloadCsv(
  reportId: string,
  params?: RequestOptions['params'],
): Promise<{ filename: string; rows: number }> {
  const token = tokenStore.get();
  const response = await fetch(buildUrl(`/reports/${reportId}/download`, params), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    let message = `Export failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      if (payload?.error?.message) message = payload.error.message;
    } catch {
      /* keep generic message */
    }
    throw new ApiError(message, response.status);
  }

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match?.[1] ?? `${reportId}.csv`;
  const rows = Number(response.headers.get('X-Row-Count') ?? 0);

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  return { filename, rows };
}

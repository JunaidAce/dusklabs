export interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
    issues?: Array<{ path: string; message: string }>;
  };
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: Array<{ path: string; message: string }>;

  constructor(
    status: number,
    code: string,
    message: string,
    issues?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

let inMemoryCsrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  inMemoryCsrfToken = token;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData;

  if (init.body && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && inMemoryCsrfToken) {
    headers.set('X-CSRF-Token', inMemoryCsrfToken);
  }

  const response = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    let payload: ApiErrorPayload = {};
    try {
      payload = (await response.json()) as ApiErrorPayload;
    } catch {
      // Non-JSON error fallback
    }
    throw new ApiClientError(
      response.status,
      payload.error?.code ?? 'REQUEST_FAILED',
      payload.error?.message ?? `Request failed (${response.status})`,
      payload.error?.issues,
    );
  }

  return (await response.json()) as T;
}

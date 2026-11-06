// Small wrapper around fetch() used for every REST call.
// - adds the JWT ("Authorization: Bearer ...") automatically
// - turns error responses into an ApiError with the server's message and field errors
// - when the server answers 401 for a logged-in user (token expired / logged out), calls onUnauthorized


const TOKEN_KEY = 'chatspace.token';

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || ''
).replace(/\/+$/, '');

let unauthorizedHandler = null;

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked
  }
}

export class ApiError extends Error {
  constructor(status, message, fieldErrors) {
    super(message);
    this.status = status;
    this.fieldErrors = fieldErrors || {};
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const headers = {};

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (!API_BASE_URL) {
    throw new ApiError(
      0,
      'Backend URL is missing. Check VITE_API_BASE_URL in Vercel.'
    );
  }

  let res;

  try {
    res = await fetch(`${API_BASE_URL}/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot connect to backend server.');
  }

  if (res.status === 204) return null;

  let data = null;
  const text = await res.text();

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && token && unauthorizedHandler) {
      unauthorizedHandler();
    }

    const message =
      data?.message ||
      `Request failed (${res.status})`;

    throw new ApiError(res.status, message, data?.fieldErrors);
  }

  return data;
}

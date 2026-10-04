export function httpUrl(options: { protocol?: string; host: string; port?: number; path?: string }): string {
  const suffix = options.port ? `:${options.port}` : "";
  return `${options.protocol ?? "http"}://${options.host}${suffix}${leadingSlash(options.path)}`;
}

export function rtspUrl(options: { host: string; port?: number; username?: string; password?: string; path?: string }): string {
  return `rtsp://${userInfo(options.username, options.password)}${options.host}:${options.port ?? 554}${leadingSlash(options.path)}`;
}

export function httpAuthUrl(options: { protocol?: string; host: string; port?: number; username?: string; password?: string; path?: string }): string {
  const suffix = options.port ? `:${options.port}` : "";
  return `${options.protocol ?? "http"}://${userInfo(options.username, options.password)}${options.host}${suffix}${leadingSlash(options.path)}`;
}

/** A folder name that is safe on Windows for a camera's recordings. */
export function safeFolderName(value: unknown): string {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const CREDENTIAL_PARAMS = /([?&](?:password|pwd|pass|token)=)[^&#\s]*/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)[^@/\s]+@/gi;

/** Camera URLs carry passwords in the userinfo or the query; never write one to a log. */
export function redactCredentials(text: string): string {
  return text.replace(URL_USERINFO, "$1***@").replace(CREDENTIAL_PARAMS, "$1***");
}

function userInfo(username?: string, password?: string): string {
  if (!username) return "";
  return `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ""}@`;
}

function leadingSlash(path = "/"): string {
  return path.startsWith("/") ? path : `/${path}`;
}

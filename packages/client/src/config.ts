import { z } from "zod";
export interface ConnectionOptions { readonly baseUrl: string; readonly token: string }
export function connection(options: ConnectionOptions) {
  const url = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError("Expected an HTTP(S) base URL without credentials, query or fragment");
  const token = z.string().min(1).regex(/^[\x21-\x7e]+$/).parse(options.token);
  return { baseUrl: url.href.replace(/\/$/, ""), headers: { Authorization: `Bearer ${token}` } };
}

// Minimal Node implementation of the parts of the Obsidian API the sync code uses.
// Tests are bundled with esbuild aliasing "obsidian" to this file.
import { promises as fs, existsSync } from "fs";
import * as path from "path";
import { handleFakeRequest } from "./fake-github";

export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const buf = Buffer.from(base64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export const notices: string[] = [];
export class Notice {
  constructor(message: string, _timeout?: number) {
    notices.push(message);
  }
  hide() {}
}

class Adapter {
  constructor(private root: string) {}

  private full(p: string) {
    return path.join(this.root, normalizePath(p));
  }

  async exists(p: string) {
    return existsSync(this.full(p));
  }
  async stat(p: string) {
    try {
      const s = await fs.stat(this.full(p));
      return {
        type: s.isDirectory() ? "folder" : "file",
        mtime: s.mtimeMs,
        ctime: s.ctimeMs,
        size: s.size,
      };
    } catch {
      return null;
    }
  }
  async list(p: string) {
    const dir = normalizePath(p);
    const entries = await fs.readdir(this.full(dir), { withFileTypes: true });
    const join = (n: string) => (dir === "" ? n : `${dir}/${n}`);
    return {
      files: entries.filter((e) => e.isFile()).map((e) => join(e.name)),
      folders: entries.filter((e) => e.isDirectory()).map((e) => join(e.name)),
    };
  }
  async read(p: string) {
    return await fs.readFile(this.full(p), "utf8");
  }
  async readBinary(p: string): Promise<ArrayBuffer> {
    const buf = await fs.readFile(this.full(p));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  async write(p: string, data: string) {
    await fs.mkdir(path.dirname(this.full(p)), { recursive: true });
    await fs.writeFile(this.full(p), data, "utf8");
  }
  async writeBinary(p: string, data: ArrayBuffer) {
    await fs.mkdir(path.dirname(this.full(p)), { recursive: true });
    await fs.writeFile(this.full(p), Buffer.from(data));
  }
  async append(p: string, data: string) {
    await fs.appendFile(this.full(p), data, "utf8");
  }
  async mkdir(p: string) {
    await fs.mkdir(this.full(p), { recursive: true });
  }
  async remove(p: string) {
    await fs.unlink(this.full(p));
  }
  async rmdir(p: string, recursive: boolean) {
    if (recursive) await fs.rm(this.full(p), { recursive: true });
    else await fs.rmdir(this.full(p));
  }
  async trashLocal(p: string) {
    const target = this.full(`.trash/${normalizePath(p)}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(this.full(p), target);
  }
}

export class Vault {
  configDir = ".obsidian";
  adapter: Adapter;
  constructor(public root: string) {
    this.adapter = new Adapter(root);
  }
  getRoot() {
    return { path: "/" };
  }
}

interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
}

// Spaces out real write requests to stay below GitHub's secondary rate limit
// of 80 content-creating requests per minute.
let lastWrite = 0;
export async function throttleWrite() {
  const wait = lastWrite + 900 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastWrite = Date.now();
}

export async function requestUrl(options: RequestUrlParam) {
  const fake = handleFakeRequest(options);
  if (fake) {
    return fake;
  }
  if ((options.method || "GET") !== "GET") {
    await throttleWrite();
  }
  const response = await fetch(options.url, {
    method: options.method || "GET",
    headers: options.headers,
    body: options.body,
  });
  const arrayBuffer = await response.arrayBuffer();
  let json: any = undefined;
  try {
    json = JSON.parse(Buffer.from(arrayBuffer).toString("utf8"));
  } catch {
    // Not JSON, e.g. a zip archive
  }
  return { status: response.status, json, arrayBuffer };
}

export type EventRef = unknown;

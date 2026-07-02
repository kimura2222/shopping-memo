// ブラウザのローカルストレージを使ったオフライン対応。
// - キャッシュ: 最後に取得したリストを保存 → オフラインでも閲覧できる
// - 書き込みキュー: オフライン中の更新を溜めて、オンライン復帰時に同期する
import type { ShoppingItem, GroupField, EditableField } from "./notion";

const CACHE_KEY = "shoppingCache:v1";
const QUEUE_KEY = "shoppingQueue:v1";
const LASTSYNC_KEY = "shoppingLastSync:v1";

export interface CachedData {
  items: ShoppingItem[];
  fields: GroupField[];
  doneProp: string | null;
  priceProp: string | null;
  statusProp: string | null;
  statusCompleteValue: string | null;
  statusCompleteValues: string[];
  statusTodoValue: string | null;
  defaultGroup: string | null;
  demo: boolean;
  editableFields: EditableField[];
  titleParts: string[];
  noteProp: string | null;
  urlProps: string[];
}

export interface QueueOp {
  id: string;
  props: { name: string; type: string; value: any }[];
  /** 同期の試行回数(上限に達したら破棄してキューの詰まりを防ぐ) */
  tries?: number;
}

function safeGet(key: string): any {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: any) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 容量超過などは無視
  }
}

export function loadCache(): CachedData | null {
  return safeGet(CACHE_KEY);
}

export function saveCache(data: CachedData) {
  safeSet(CACHE_KEY, data);
}

export function loadQueue(): QueueOp[] {
  return safeGet(QUEUE_KEY) ?? [];
}

export function saveQueue(q: QueueOp[]) {
  safeSet(QUEUE_KEY, q);
}

export function enqueue(op: QueueOp) {
  const q = loadQueue();
  q.push(op);
  saveQueue(q);
}

export function loadLastSync(): number | null {
  const v = safeGet(LASTSYNC_KEY);
  return typeof v === "number" ? v : null;
}

export function saveLastSync(ts: number) {
  safeSet(LASTSYNC_KEY, ts);
}

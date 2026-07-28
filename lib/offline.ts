// ブラウザのローカルストレージを使ったオフライン対応。
// - キャッシュ: 最後に取得したリストを保存 → オフラインでも閲覧できる
// - 書き込みキュー: オフライン中の更新を溜めて、オンライン復帰時に同期する
import type { ShoppingItem, GroupField, EditableField } from "./notion";

const CACHE_KEY = "shoppingCache:v1";
const QUEUE_KEY = "shoppingQueue:v1";
const LASTSYNC_KEY = "shoppingLastSync:v1";
const DBLIST_KEY = "shoppingDatabases:v1";
const ACTIVEDB_KEY = "shoppingActiveDb:v1";

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

// キャッシュはデータベースごとに分ける(切替時に混ざらないように)
export function loadCache(dbId: string): CachedData | null {
  return safeGet(`${CACHE_KEY}:${dbId}`);
}

export function saveCache(dbId: string, data: CachedData) {
  safeSet(`${CACHE_KEY}:${dbId}`, data);
}

// 登録済みデータベースの一覧と選択中ID
export interface DbEntry {
  id: string;
  title: string;
  url?: string;
}

export function loadDatabases(): DbEntry[] {
  const v = safeGet(DBLIST_KEY);
  return Array.isArray(v) ? v : [];
}

export function saveDatabases(list: DbEntry[]) {
  safeSet(DBLIST_KEY, list);
}

export function loadActiveDb(): string | null {
  const v = safeGet(ACTIVEDB_KEY);
  return typeof v === "string" ? v : null;
}

export function saveActiveDb(id: string) {
  safeSet(ACTIVEDB_KEY, id);
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

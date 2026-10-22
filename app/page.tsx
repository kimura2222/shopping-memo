"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  EditableField,
  EditValue,
  GroupField,
  ItemsResponse,
  ShoppingItem,
} from "@/lib/notion";
import { colorFor } from "@/lib/colors";
import {
  coalesceQueue,
  enqueue,
  loadActiveDb,
  loadCache,
  loadDatabases,
  loadLastSync,
  loadLocalDone,
  loadQueue,
  saveActiveDb,
  saveCache,
  saveDatabases,
  saveLastSync,
  saveLocalDone,
  saveQueue,
  type CachedData,
  type DbEntry,
  type QueueOp,
} from "@/lib/offline";

const MAX_SYNC_TRIES = 5;
// Notionの回数制限(約3回/秒)・混雑で断られたときの再送間隔
const THROTTLE_RETRIES = 2;
const THROTTLE_WAIT_MS = 1000;
const THROTTLE_RESUME_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 会場の混雑回線で応答待ちのまま固まらないよう、通信に上限時間を設ける
const SYNC_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 20_000;
// Notion画像の署名URLは約1時間で失効するので、それより前に取り直す
const DETAIL_TTL_MS = 50 * 60 * 1000;

async function fetchWithTimeout(input: string, init: RequestInit = {}, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(input, { ...init, signal: ctrl.signal });
    if (res.status === 401) {
      // ログイン切れ(パスコード変更など)。未同期の更新は端末に残したまま、ログイン画面へ。
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      throw new Error("ログインが必要です");
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

const NO_GROUP = "__none__";
const UNSET = "(未設定)";

// 背景色の条件付き表示に使う列/値
const PRIORITY_FIELD = "優先度";
const PRIORITY_HIGH = "高";

interface Detail {
  loading: boolean;
  images: { url: string; caption: string }[];
  texts: string[];
  error?: string;
  /** 取得時刻(画像URLの失効前に取り直す判定用) */
  fetchedAt?: number;
}

// 50音の並び順。清音(あ〜ん)を先に、濁音・半濁音はその後ろにまとめる。
const KANA_ORDER =
  "ぁあぃいぅうぇえぉお" +
  "かきくけこ" +
  "さしすせそ" +
  "たちっつてと" +
  "なにぬねの" +
  "はひふへほ" +
  "まみむめも" +
  "ゃやゅゆょよ" +
  "らりるれろ" +
  "ゎわゐゑをん" +
  "ー" +
  // ↓ ここから濁音・半濁音(あ〜んの次)
  "がぎぐげご" +
  "ざじずぜぞ" +
  "だぢづでど" +
  "ばびぶべぼ" +
  "ぱぴぷぺぽ" +
  "ゔ";

const KANA_RANK: Record<string, number> = Object.fromEntries(
  [...KANA_ORDER].map((c, i) => [c, i])
);

// 並び順の階層: ひらがな(清音→濁音半濁音) < 漢字・英数記号 < カタカナ(最後尾)
const NONKANA_BASE = KANA_ORDER.length; // ひらがなの後ろ
const KATAKANA_BASE = 0x200000; // どの文字コードよりも大きく → 常に最後

function rankOf(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  // カタカナ(反復記号ヽヾ含む)は最後尾へ。内部はひらがな相当の50音順で並べる。
  if ((c >= 0x30a1 && c <= 0x30fa) || c === 0x30fd || c === 0x30fe) {
    const hira = String.fromCodePoint(c - 0x60);
    const sub = KANA_RANK[hira] ?? c - 0x30a1;
    return KATAKANA_BASE + sub;
  }
  const r = KANA_RANK[ch];
  if (r != null) return r; // ひらがな(清音・濁音・半濁音)
  return NONKANA_BASE + c; // 漢字・英数・記号(ひらがなの後、カタカナの前)
}

// 50音(濁音は後ろ)でタイトルを比較
function jpCompare(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const d = rankOf(A[i]) - rankOf(B[i]);
    if (d !== 0) return d;
  }
  return A.length - B.length;
}

export default function Home() {
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [fields, setFields] = useState<GroupField[]>([]);
  const [doneProp, setDoneProp] = useState<string | null>(null);
  const [priceProp, setPriceProp] = useState<string | null>(null);
  // チェック⇄状態 連動用
  const [statusProp, setStatusProp] = useState<string | null>(null);
  const [statusComplete, setStatusComplete] = useState<string | null>(null);
  const [statusCompleteSet, setStatusCompleteSet] = useState<Set<string>>(new Set());
  const [statusTodo, setStatusTodo] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // オフライン対応
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // 複数データベース
  const [databases, setDatabases] = useState<DbEntry[]>([]);
  const [activeDb, setActiveDb] = useState<string | null>(null);
  const activeDbRef = useRef<string | null>(null); // 最新のactiveDbを参照(イベントハンドラの陳腐化対策)
  // 完了列が無いDB向けのローカル完了(端末にだけ保存、Notion非連動)
  const [localDone, setLocalDone] = useState<Set<string>>(new Set());

  const [query, setQuery] = useState("");
  const [hideDone, setHideDone] = useState(false);
  const [groupBy, setGroupBy] = useState<string>(NO_GROUP);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // テーマ(自動 / ライト / ダーク)
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");

  // 折り畳み(詳細)の展開状態と、遅延取得した本文
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<
    Record<string, Detail>
  >({});

  // 編集パネル
  const [editableFields, setEditableFields] = useState<EditableField[]>([]);
  const [titleParts, setTitleParts] = useState<string[]>([]);
  const [noteProp, setNoteProp] = useState<string | null>(null);
  const [urlProps, setUrlProps] = useState<string[]>([]);
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Record<string, Record<string, EditValue>>>({});

  // 取得データ(サーバー/キャッシュ共通)を画面状態へ反映
  function applyData(data: Partial<CachedData> & Partial<ItemsResponse>, fromCache: boolean) {
    setItems(data.items ?? []);
    setFields(data.fields ?? []);
    setDoneProp(data.doneProp ?? null);
    setPriceProp(data.priceProp ?? null);
    setStatusProp(data.statusProp ?? null);
    setStatusComplete(data.statusCompleteValue ?? null);
    setStatusCompleteSet(new Set(data.statusCompleteValues ?? []));
    setStatusTodo(data.statusTodoValue ?? null);
    setEditableFields(data.editableFields ?? []);
    setTitleParts(data.titleParts ?? []);
    setNoteProp(data.noteProp ?? null);
    setUrlProps(data.urlProps ?? []);
    setDemo(data.demo ?? false);
    if (fromCache) {
      setGroupBy(data.defaultGroup ?? NO_GROUP);
    } else {
      setGroupBy((prev) =>
        prev !== NO_GROUP && (data.fields ?? []).some((f) => f.name === prev)
          ? prev
          : data.defaultGroup ?? NO_GROUP
      );
    }
  }

  function markSynced() {
    const ts = Date.now();
    setLastSync(ts);
    saveLastSync(ts);
  }

  // 溜まった更新をNotionへ順次同期。
  // - 同じアイテムへの複数の更新は、最後の状態の1件にまとめてから送る
  // - ネットワーク不通: そのop以降を保持して中断(オンライン復帰時に再開)
  // - Notionの回数制限・混雑(429/503): 捨てずに少し待って再送。続くなら中断して後で再開
  // - サーバー拒否(不正な値・削除済み等): 再試行回数を数え、上限で破棄して"詰まり"を防ぐ
  // 同時に2本走ると同じopを二重送信したり、到着順が入れ替わったりするため、
  // 呼び出しは前の同期が終わってから順に実行する(直列化)。
  const flushChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flushQueue(): Promise<boolean> {
    const run = flushChainRef.current.then(flushQueueOnce, flushQueueOnce);
    flushChainRef.current = run;
    return run;
  }

  async function flushQueueOnce(): Promise<boolean> {
    const q = loadQueue();
    if (q.length === 0) {
      setPending(0);
      return true;
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setOnline(false);
      setPending(q.length);
      return false;
    }
    const ops = coalesceQueue(q);
    const remaining: QueueOp[] = [];
    let dropped = 0;
    let networkFailed = false;
    let throttled = false;
    for (const op of ops) {
      if (networkFailed || throttled) {
        remaining.push(op); // 中断後は手を付けず保持
        continue;
      }
      try {
        let res: Response | null = null;
        for (let attempt = 0; attempt <= THROTTLE_RETRIES; attempt++) {
          if (attempt > 0) await sleep(THROTTLE_WAIT_MS * attempt);
          res = await fetchWithTimeout(
            "/api/items",
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "update", id: op.id, props: op.props }),
            },
            SYNC_TIMEOUT_MS
          );
          if (res.status !== 429 && res.status !== 503) break;
        }
        if (res!.ok) continue; // 成功 → キューから除去
        if (res!.status === 429 || res!.status === 503) {
          throttled = true; // 一時的な失敗 → 回数に数えず保持し、少し後に再開
          remaining.push(op);
          continue;
        }
        // サーバーは応答したが失敗 → 再試行回数を加算、上限で破棄
        const tries = (op.tries ?? 0) + 1;
        if (tries >= MAX_SYNC_TRIES) dropped++;
        else remaining.push({ ...op, tries });
      } catch {
        networkFailed = true; // ネットワーク不通・タイムアウト → 保持して以降中断
        remaining.push(op);
      }
    }
    // 送信中に積まれた新しいopは末尾にあるので、それを消さずに残す
    const added = loadQueue().slice(q.length);
    const next = [...remaining, ...added];
    saveQueue(next);
    setPending(next.length);
    if (networkFailed) setOnline(false);
    if (throttled && !retryTimerRef.current) {
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        flushQueue();
      }, THROTTLE_RESUME_MS);
    }
    const fullySynced = next.length === 0 && !networkFailed;
    if (dropped > 0) {
      setSyncError(
        `${dropped}件の更新をNotionに反映できませんでした(スキップ)。該当項目を確認してください。`
      );
    } else if (fullySynced) {
      setSyncError(null);
    }
    if (fullySynced) markSynced();
    return fullySynced;
  }

  // Notionに接続されているDB一覧を取得(PC・スマホ共通)。オフライン用に端末にも保存。
  // 選択中のDBが一覧から消えていたら(Notionで接続を外した等)、先頭のDBへ切り替える。
  async function syncDbList() {
    try {
      const res = await fetchWithTimeout("/api/db/list", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const list: DbEntry[] = Array.isArray(data.databases) ? data.databases : [];
      if (list.length === 0) return; // デモ・取得失敗時は今の一覧のまま
      setDatabases(list);
      saveDatabases(list);
      const cur = activeDbRef.current;
      if (cur && !list.some((d) => d.id === cur)) {
        activeDbRef.current = null; // selectDb の「同じDBなら何もしない」を回避
        selectDb(list[0].id);
      }
    } catch {
      // オフライン等は保存済みの一覧を使う
    }
  }

  // オンライン時: キュー同期 → 選択中DBを取得。オフライン時: キャッシュのまま。
  async function refresh(dbId: string | null = activeDbRef.current) {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setOnline(false);
      setLoading(false);
      return;
    }
    setOnline(true);
    const synced = await flushQueue();
    if (!synced) {
      setLoading(false);
      return; // 同期しきれていないので取得はスキップ(ローカルを優先)
    }
    // 取得中に別のDBへ切り替えられたら、この結果は捨てる
    // (反映すると別DBの中身が表示され、さらにそのDBのキャッシュとして保存されてしまう)
    // 判定は応答が届いた時点で一度だけ行う(初回は下で activeDbRef を埋めるため、後から再判定すると誤る)
    const isStale = () => dbId !== activeDbRef.current;
    let stale = false;
    try {
      const url = dbId ? `/api/items?db=${encodeURIComponent(dbId)}` : "/api/items";
      const res = await fetchWithTimeout(url, { cache: "no-store" });
      const data: ItemsResponse = await res.json();
      stale = isStale();
      if (stale) return;
      if (data.error && !(data.items && data.items.length)) {
        setError(data.error);
      } else {
        applyData(data, false);
        setError(data.error ?? null);
        markSynced();
        // 未選択(初回)なら、表示できた既定DBを選択状態にする
        if (data.dbId && !activeDbRef.current) {
          activeDbRef.current = data.dbId;
          setActiveDb(data.dbId);
          saveActiveDb(data.dbId);
        }
      }
    } catch {
      stale = isStale();
      if (!stale) setOnline(false);
    } finally {
      if (!stale) setLoading(false);
    }
  }

  // データベースを切り替える
  function selectDb(id: string) {
    if (!id || id === activeDbRef.current) return;
    activeDbRef.current = id;
    setActiveDb(id);
    saveActiveDb(id);
    setLocalDone(new Set(loadLocalDone(id)));
    const c = loadCache(id);
    if (c) {
      applyData(c, true);
      setLoading(false);
    } else {
      // 前のDBの中身が残ったままだと、それがこのDBのキャッシュとして保存されうるので空にする
      applyData({}, true);
      setLoading(true);
    }
    refresh(id);
  }

  // activeDb の最新値を ref に同期(イベントハンドラの陳腐化対策)
  useEffect(() => {
    activeDbRef.current = activeDb;
  }, [activeDb]);

  // 初回: 登録済みDBと選択を復元 → キャッシュを即描画 → オンラインなら最新化
  useEffect(() => {
    const dbs = loadDatabases();
    const savedActive = loadActiveDb();
    const initialActive =
      savedActive && dbs.some((d) => d.id === savedActive)
        ? savedActive
        : dbs[0]?.id ?? null;
    setDatabases(dbs);
    setActiveDb(initialActive);
    activeDbRef.current = initialActive;
    if (initialActive) {
      const cached = loadCache(initialActive);
      if (cached) {
        applyData(cached, true);
        setLoading(false);
      }
      setLocalDone(new Set(loadLocalDone(initialActive)));
    }
    setPending(loadQueue().length);
    setLastSync(loadLastSync());
    if (typeof navigator !== "undefined") setOnline(navigator.onLine);
    refresh(initialActive);
    syncDbList(); // DB一覧は起動時・手動更新・オンライン復帰時だけ取り直す(切替のたびには取らない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // テーマ・並び順: 起動時に保存値を復元
  useEffect(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark" || saved === "system") setTheme(saved);
    const dir = localStorage.getItem("sortDir");
    if (dir === "asc" || dir === "desc") setSortDir(dir);
  }, []);

  // 並び順の選択を保存
  useEffect(() => {
    localStorage.setItem("sortDir", sortDir);
  }, [sortDir]);

  // テーマ: 選択を <html data-theme> へ反映し保存。自動時は OS 設定に追従。
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      if (dark) root.setAttribute("data-theme", "dark");
      else root.removeAttribute("data-theme");
    };
    apply();
    localStorage.setItem("theme", theme);
    if (theme === "system") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  // オンライン/オフラインの変化に追従
  useEffect(() => {
    function onOnline() {
      setOnline(true);
      refresh();
      syncDbList();
    }
    function onOffline() {
      setOnline(false);
    }
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 画面状態が変わるたびに、選択中DBのキャッシュへ保存(オフライン閲覧用)
  useEffect(() => {
    if (loading || !activeDb) return;
    saveCache(activeDb, {
      items,
      fields,
      doneProp,
      priceProp,
      statusProp,
      statusCompleteValue: statusComplete,
      statusCompleteValues: [...statusCompleteSet],
      statusTodoValue: statusTodo,
      defaultGroup: groupBy,
      demo,
      editableFields,
      titleParts,
      noteProp,
      urlProps,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, fields, groupBy, doneProp, priceProp, statusProp, statusComplete, statusTodo, demo, loading, editableFields, titleParts, noteProp, urlProps, activeDb]);

  const fieldMap = useMemo(() => {
    const m = new Map<string, GroupField>();
    for (const f of fields) m.set(f.name, f);
    return m;
  }, [fields]);

  function optionColor(fieldName: string, value: string) {
    const f = fieldMap.get(fieldName);
    const opt = f?.options.find((o) => o.name === value);
    return colorFor(opt?.color);
  }

  // 補足ラベル(駅名・種類など)を名前ごとに色分け(安定したハッシュで割当)
  const KEY_PALETTE = ["blue", "green", "orange", "purple", "pink", "brown", "yellow", "red"];
  function keyColor(name: string) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return colorFor(KEY_PALETTE[h % KEY_PALETTE.length]);
  }

  // 更新はまずキューに積んでから同期を試みる。
  // オフラインなら溜めておき、オンライン復帰時に自動同期(画面は楽観的に更新済み)。
  async function sendUpdate(
    id: string,
    props: { name: string; type: string; value: any }[]
  ) {
    if (demo || props.length === 0) return; // デモは書き込まない
    const op: QueueOp = { id, props };
    enqueue(op);
    setPending(loadQueue().length);
    await flushQueue();
  }

  // 完了チェック: チェックと「状態」を1回でまとめて更新(連動)
  async function toggleDone(item: ShoppingItem) {
    const next = !item.done;
    const linkStatus = Boolean(statusProp && statusComplete);
    const nextStatus = next ? statusComplete : statusTodo;

    setItems((prev) =>
      prev.map((it) =>
        it.id === item.id
          ? {
              ...it,
              done: next,
              values: linkStatus
                ? { ...it.values, [statusProp!]: nextStatus ? [nextStatus] : [] }
                : it.values,
            }
          : it
      )
    );

    const props: { name: string; type: string; value: any }[] = [];
    if (doneProp) props.push({ name: doneProp, type: "checkbox", value: next });
    if (linkStatus) props.push({ name: statusProp!, type: "status", value: nextStatus });
    await sendUpdate(item.id, props);
  }

  // 完了列が無いDB向け: 端末にだけ完了状態を保存(Notion非連動、グレーアウトのみ)
  function toggleLocalDone(id: string) {
    setLocalDone((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (activeDbRef.current) saveLocalDone(activeDbRef.current, [...next]);
      return next;
    });
  }

  // 状態タグの変更: 「状態」列なら完了チェックも自動で連動させる
  async function changeField(item: ShoppingItem, field: GroupField, value: string) {
    const syncDone = field.name === statusProp && doneProp;
    const nextDone = syncDone ? statusCompleteSet.has(value) : item.done;

    setItems((prev) =>
      prev.map((it) =>
        it.id === item.id
          ? {
              ...it,
              done: syncDone ? nextDone : it.done,
              values: { ...it.values, [field.name]: value ? [value] : [] },
            }
          : it
      )
    );

    const props: { name: string; type: string; value: any }[] = [
      { name: field.name, type: field.type, value },
    ];
    if (syncDone) props.push({ name: doneProp!, type: "checkbox", value: nextDone });
    await sendUpdate(item.id, props);
  }

  // ---- 項目内容の編集 ----
  function toggleEdit(item: ShoppingItem) {
    setEditing((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    if (!editing.has(item.id)) {
      setDraft((prev) => ({ ...prev, [item.id]: { ...item.edit } }));
    }
  }

  function cancelEdit(item: ShoppingItem) {
    setEditing((prev) => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
  }

  function setDraftValue(id: string, name: string, value: EditValue) {
    setDraft((prev) => ({ ...prev, [id]: { ...prev[id], [name]: value } }));
  }

  const asStr = (v: EditValue): string =>
    v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
  const sameValue = (a: EditValue, b: EditValue) =>
    Array.isArray(a) || Array.isArray(b)
      ? JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
      : (a ?? "") === (b ?? "");

  // 編集内容から表示用フィールド(タイトル・価格・メモ・リンク・タグ)を再計算
  function rebuildDisplay(item: ShoppingItem, d: Record<string, EditValue>) {
    const title =
      titleParts
        .map((n) => asStr(d[n]).trim())
        .filter(Boolean)
        .join(" / ") || "(名称未設定)";

    let price = item.price;
    if (priceProp && priceProp in d) {
      const v = d[priceProp];
      price = v === "" || v == null ? null : Number(v);
    }

    let note = item.note;
    if (noteProp && noteProp in d) note = asStr(d[noteProp]) || null;

    const links = urlProps.length
      ? urlProps
          .map((n) => ({ label: n, url: asStr(d[n]) }))
          .filter((l) => l.url)
      : item.links;

    const values = { ...item.values };
    for (const f of fields) {
      if (f.name in d) {
        const dv = d[f.name];
        values[f.name] = Array.isArray(dv) ? dv : dv ? [String(dv)] : [];
      }
    }
    return { title, price, note, links, values };
  }

  async function saveEdit(item: ShoppingItem) {
    const d = draft[item.id] ?? {};
    const props: { name: string; type: string; value: any }[] = [];
    for (const f of editableFields) {
      if (!sameValue(d[f.name], item.edit[f.name])) {
        props.push({ name: f.name, type: f.type, value: d[f.name] });
      }
    }
    const disp = rebuildDisplay(item, d);
    setItems((prev) =>
      prev.map((it) => (it.id === item.id ? { ...it, ...disp, edit: { ...d } } : it))
    );
    cancelEdit(item);
    if (props.length) await sendUpdate(item.id, props);
  }

  function renderEditInput(id: string, f: EditableField) {
    const cur = draft[id]?.[f.name];
    switch (f.type) {
      case "number":
        return (
          <input
            className="edit-input"
            type="number"
            inputMode="numeric"
            value={cur == null ? "" : String(cur)}
            onChange={(e) =>
              setDraftValue(id, f.name, e.target.value === "" ? "" : Number(e.target.value))
            }
          />
        );
      case "date":
        return (
          <input
            className="edit-input"
            type="date"
            value={asStr(cur)}
            onChange={(e) => setDraftValue(id, f.name, e.target.value)}
          />
        );
      case "select":
      case "status":
        return (
          <select
            className="edit-input"
            value={asStr(cur)}
            onChange={(e) => setDraftValue(id, f.name, e.target.value)}
          >
            <option value="">—</option>
            {(f.options ?? []).map((o) => (
              <option key={o.name} value={o.name}>
                {o.name}
              </option>
            ))}
          </select>
        );
      case "multi_select": {
        const selected = Array.isArray(cur) ? cur : [];
        return (
          <div className="edit-chips">
            {(f.options ?? []).map((o) => {
              const on = selected.includes(o.name);
              const c = colorFor(o.color);
              return (
                <button
                  type="button"
                  key={o.name}
                  className={`chip ${on ? "on" : ""}`}
                  style={on ? { background: c.bg, color: c.fg } : undefined}
                  onClick={() =>
                    setDraftValue(
                      id,
                      f.name,
                      on ? selected.filter((x) => x !== o.name) : [...selected, o.name]
                    )
                  }
                >
                  {o.name}
                </button>
              );
            })}
          </div>
        );
      }
      default: // title / rich_text / url
        return (
          <input
            className="edit-input"
            type="text"
            value={asStr(cur)}
            onChange={(e) => setDraftValue(id, f.name, e.target.value)}
          />
        );
    }
  }

  async function toggleDetail(item: ShoppingItem) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    // 開くとき、未取得・前回失敗・画像URLの失効が近い場合は本文を(再)取得
    const cur = details[item.id];
    const needsFetch =
      !cur ||
      (!cur.loading &&
        (Boolean(cur.error) || Date.now() - (cur.fetchedAt ?? 0) > DETAIL_TTL_MS));
    if (!expanded.has(item.id) && needsFetch) {
      setDetails((prev) => ({
        ...prev,
        [item.id]: { loading: true, images: [], texts: [] },
      }));
      try {
        const res = await fetchWithTimeout(`/api/items/${item.id}`, { cache: "no-store" });
        const data = await res.json();
        setDetails((prev) => ({
          ...prev,
          [item.id]: {
            loading: false,
            images: data.images ?? [],
            texts: data.texts ?? [],
            error: data.error,
            fetchedAt: Date.now(),
          },
        }));
      } catch (e: any) {
        setDetails((prev) => ({
          ...prev,
          [item.id]: {
            loading: false,
            images: [],
            texts: [],
            error:
              e?.name === "AbortError"
                ? "タイムアウトしました(電波を確認してください)"
                : e?.message ?? "取得に失敗しました",
          },
        }));
      }
    }
  }

  // 完了列があるDBはNotionのdone、無いDBはローカル完了を「完了」とみなす
  const canComplete = Boolean(doneProp || (statusProp && statusComplete));
  const isDone = (it: ShoppingItem) =>
    canComplete ? it.done : localDone.has(it.id);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = items.filter((it) => {
      if (hideDone && isDone(it)) return false;
      if (!q) return true;
      const hay = [
        it.title,
        it.note ?? "",
        ...Object.values(it.values).flat(),
        ...it.extra.map((e) => e.value),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    // 基本並び順: タイトルを50音順(濁音・半濁音は後ろ)。昇順/降順で反転。
    const dir = sortDir === "asc" ? 1 : -1;
    return list.sort((a, b) => jpCompare(a.title, b.title) * dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query, hideDone, sortDir, localDone, canComplete]);

  const grouped = useMemo(() => {
    if (groupBy === NO_GROUP) return [[UNSET, filtered]] as [string, ShoppingItem[]][];
    const map = new Map<string, ShoppingItem[]>();
    for (const it of filtered) {
      const key = it.values[groupBy]?.[0] || UNSET;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(it);
    }
    const field = fieldMap.get(groupBy);
    // Notion の選択肢の並び順を尊重し、未設定は最後
    const order = field ? field.options.map((o) => o.name) : [];
    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === UNSET) return 1;
      if (b[0] === UNSET) return -1;
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      if (ia !== -1 && ib !== -1) return ia - ib;
      return a[0].localeCompare(b[0], "ja");
    });
  }, [filtered, groupBy, fieldMap]);

  const total = items.length;
  const doneCount = items.filter((it) => isDone(it)).length;
  const remainingPrice = useMemo(
    () => items.filter((it) => !isDone(it)).reduce((s, it) => s + (it.price ?? 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, localDone, canComplete]
  );
  const hasPrice = priceProp != null && items.some((it) => it.price != null);
  const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");
  const fmtSync = (ts: number) => {
    const d = new Date(ts);
    const hm = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };

  const showGroupHeader = groupBy !== NO_GROUP;

  return (
    <div className="container">
      <header className="header">
        <h1 className="title">🛒 買い物リスト</h1>
        <div className="stats">
          {total > 0 && (
            <span className="progress">
              {doneCount} / {total} 完了
            </span>
          )}
          {hasPrice && (
            <span className="total" title="未購入アイテムの合計金額">
              残り {yen(remainingPrice)}
            </span>
          )}
          {!online && <span className="pill offline">● オフライン</span>}
          {pending > 0 && (
            <span className="pill pending" title="Notion 未同期の変更">
              未同期 {pending}
            </span>
          )}
          {lastSync && (
            <span className="synced" title="Notion と最後に同期した時刻">
              同期 {fmtSync(lastSync)}
            </span>
          )}
        </div>
      </header>

      {/* データベース切替バー(一覧はNotionで「接続」したDB) */}
      {!demo && databases.length > 0 && (
        <div className="db-bar">
          <select
            className="db-select"
            value={activeDb ?? ""}
            onChange={(e) => selectDb(e.target.value)}
            title="表示するデータベース(Notionでインテグレーションに接続したDBが並びます)"
          >
            {databases.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </div>
      )}

      {demo && (
        <div className="banner">
          <strong>デモモードで表示中です。</strong> 自分の Notion とつなぐには{" "}
          <code>.env.local</code> に <code>NOTION_TOKEN</code> と{" "}
          <code>NOTION_DATABASE_ID</code> を設定してください。
        </div>
      )}
      {error && !demo && (
        <div className="banner error">
          <strong>取得エラー:</strong> {error}
        </div>
      )}
      {syncError && (
        <div className="banner error">
          <strong>同期エラー:</strong> {syncError}
          <button className="banner-close" onClick={() => setSyncError(null)}>
            閉じる
          </button>
        </div>
      )}

      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="🔍 検索(品名・タグ・メモ)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {fields.length > 0 && (
          <label className="group-select">
            <span>グループ</span>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              <option value={NO_GROUP}>なし</option>
              {fields.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="btn"
          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          title="昇順 / 降順を切替"
        >
          {sortDir === "asc" ? "↑ 昇順" : "↓ 降順"}
        </button>
        <button
          className={`btn ${hideDone ? "active" : ""}`}
          onClick={() => setHideDone((v) => !v)}
        >
          {hideDone ? "☑ 購入済みを隠す" : "購入済みを隠す"}
        </button>
        <button
          className="btn"
          onClick={() =>
            setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"))
          }
          title="テーマ切替(自動 → ライト → ダーク)"
        >
          {theme === "system" ? "🌓 自動" : theme === "light" ? "☀️ ライト" : "🌙 ダーク"}
        </button>
        <button
          className="btn"
          onClick={() => {
            refresh();
            syncDbList();
          }}
          title={pending > 0 ? "同期して再読み込み" : "再読み込み"}
        >
          {pending > 0 ? `↻ 同期(${pending})` : "↻"}
        </button>
      </div>

      {loading ? (
        <div className="spinner" aria-label="読み込み中" />
      ) : filtered.length === 0 ? (
        <div className="empty">
          {items.length === 0
            ? "アイテムがありません。"
            : "条件に一致するアイテムがありません。"}
        </div>
      ) : (
        grouped.map(([group, list]) => {
          const gc = showGroupHeader ? optionColor(groupBy, group) : null;
          return (
            <section className="category" key={group}>
              {showGroupHeader && (
                <div className="category-head">
                  <span
                    className="group-chip"
                    style={gc ? { background: gc.bg, color: gc.fg } : undefined}
                  >
                    {group}
                  </span>
                  <span className="category-count">
                    {list.filter((i) => !isDone(i)).length}件
                    {hasPrice &&
                      ` · ${yen(
                        list.filter((i) => !isDone(i)).reduce((s, i) => s + (i.price ?? 0), 0)
                      )}`}
                  </span>
                </div>
              )}
              <ul className="list">
                {list.map((item) => (
                  <li
                    key={item.id}
                    className={`item ${
                      isDone(item)
                        ? "done"
                        : item.values[PRIORITY_FIELD]?.includes(PRIORITY_HIGH)
                        ? "prio-high"
                        : ""
                    } ${item.flagged ? "flagged" : ""}`}
                  >
                    <input
                      className="checkbox"
                      type="checkbox"
                      checked={isDone(item)}
                      onChange={() =>
                        canComplete ? toggleDone(item) : toggleLocalDone(item.id)
                      }
                      aria-label={`${item.title} を完了にする`}
                    />
                    <div className="item-body">
                      <div className="item-row">
                        <span className="item-title">
                          {item.flagged && <span className="flag-badge">要認証</span>}
                          {item.title}
                        </span>
                        {item.price != null && (
                          <span className="price">{yen(item.price)}</span>
                        )}
                      </div>

                      <div className="item-meta">
                        {/* 編集可能な単一値フィールド(状態など)はドロップダウン */}
                        {fields
                          .filter((f) => f.editable)
                          .map((f) => {
                            const cur = item.values[f.name]?.[0] ?? "";
                            const c = optionColor(f.name, cur);
                            return (
                              <select
                                key={f.name}
                                className="tag-select"
                                value={cur}
                                title={f.name}
                                style={cur ? { background: c.bg, color: c.fg } : undefined}
                                onChange={(e) => changeField(item, f, e.target.value)}
                              >
                                <option value="">— {f.name} —</option>
                                {f.options.map((o) => (
                                  <option key={o.name} value={o.name}>
                                    {o.name}
                                  </option>
                                ))}
                              </select>
                            );
                          })}

                        {/* multi_select(ジャンル・優先度など)は色付きチップ */}
                        {fields
                          .filter((f) => !f.editable)
                          .flatMap((f) =>
                            (item.values[f.name] ?? []).map((v) => {
                              const c = optionColor(f.name, v);
                              return (
                                <span
                                  key={f.name + ":" + v}
                                  className="tag"
                                  style={{ background: c.bg, color: c.fg }}
                                >
                                  {v}
                                </span>
                              );
                            })
                          )}

                        {item.note && <span className="note">{item.note}</span>}
                        {item.extra.map((ex) => {
                          const kc = keyColor(ex.name);
                          return (
                            <span
                              key={ex.name}
                              className="extra"
                              style={{ borderColor: kc.bg }}
                            >
                              <span
                                className="extra-key"
                                style={{ background: kc.bg, color: kc.fg }}
                              >
                                {ex.name}
                              </span>
                              <span className="extra-val">{ex.value}</span>
                            </span>
                          );
                        })}

                        <button
                          className="detail-toggle"
                          onClick={() => toggleDetail(item)}
                          aria-expanded={expanded.has(item.id)}
                        >
                          {expanded.has(item.id) ? "詳細を閉じる ▲" : "詳細 ▾"}
                        </button>
                      </div>

                      {item.address && (
                        <div className="item-address">{item.address}</div>
                      )}

                      {expanded.has(item.id) && (
                        <div className="detail">
                          {item.links.length > 0 && (
                            <div className="detail-links">
                              {item.links.map((l) => (
                                <a
                                  key={l.label}
                                  className="detail-link"
                                  href={l.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {l.label} ↗
                                </a>
                              ))}
                            </div>
                          )}
                          {details[item.id]?.loading && (
                            <div className="detail-loading">
                              <span className="spinner-sm" /> 読み込み中…
                            </div>
                          )}
                          {details[item.id] && !details[item.id].loading && (
                            <>
                              {details[item.id].images.length > 0 && (
                                <div className="detail-images">
                                  {details[item.id].images.map((img, i) => (
                                    <a
                                      key={i}
                                      href={img.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      title={img.caption || "画像を開く"}
                                    >
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img
                                        src={img.url}
                                        alt={img.caption || item.title}
                                        loading="lazy"
                                      />
                                    </a>
                                  ))}
                                </div>
                              )}
                              {details[item.id].texts.length > 0 && (
                                <div className="detail-texts">
                                  {details[item.id].texts.map((t, i) => (
                                    <p key={i}>{t}</p>
                                  ))}
                                </div>
                              )}
                              {details[item.id].error && (
                                <div className="detail-empty">
                                  取得に失敗しました: {details[item.id].error}
                                </div>
                              )}
                              {!details[item.id].error &&
                                details[item.id].images.length === 0 &&
                                details[item.id].texts.length === 0 &&
                                item.links.length === 0 && (
                                  <div className="detail-empty">
                                    このアイテムに詳細(画像・本文・リンク)はありません。
                                  </div>
                                )}
                            </>
                          )}

                          {editableFields.length > 0 && !demo && (
                            <div className="detail-edit">
                              <button
                                className="detail-toggle"
                                onClick={() => toggleEdit(item)}
                                aria-expanded={editing.has(item.id)}
                              >
                                {editing.has(item.id) ? "編集を閉じる ▲" : "編集"}
                              </button>
                              {editing.has(item.id) && (
                                <div className="edit">
                                  {editableFields.map((f) => (
                                    <div className="edit-row" key={f.name}>
                                      <label className="edit-label">{f.name}</label>
                                      {renderEditInput(item.id, f)}
                                    </div>
                                  ))}
                                  <div className="edit-actions">
                                    <button
                                      className="btn primary"
                                      onClick={() => saveEdit(item)}
                                    >
                                      保存
                                    </button>
                                    <button className="btn" onClick={() => cancelEdit(item)}>
                                      キャンセル
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}

      <footer className="footer">
        Notion 連携 買い物リスト{demo ? "(デモ)" : ""}
      </footer>
    </div>
  );
}

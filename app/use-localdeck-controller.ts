import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import { definitionToForm, EMPTY_FORM, formToDefinition } from "./app-form";
import {
  deleteAppDefinition,
  fetchSnapshot,
  runAppAction,
  saveAppDefinition,
  syncCaddyRoutes,
  mutateDashboard,
} from "./localdeck-api";
import type {
  ActionResponse,
  ActionName,
  FormState,
  LocalApp,
  Notice,
  Snapshot,
} from "./localdeck-types";
import { SnapshotRequestGate } from "./snapshot-request-gate";

const REFRESH_INTERVAL_MS = 5_000;
const DELETE_DELAY_MS = 8_000;
const COPY_NOTICE_MS = 1_800;

type EditorMode = "create" | "edit" | null;

type PendingDelete = {
  app: LocalApp;
  timeoutId: number;
};

function requestErrorMessage(requestError: unknown, fallback: string) {
  return requestError instanceof Error ? requestError.message : fallback;
}

function warningNotice(body: ActionResponse, fallback: string): Notice | null {
  if (!body.warning) return null;
  return {
    tone: "warning",
    text: (body.message ?? fallback) + ": " + body.warning,
  };
}

export function useLocaldeckController() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeRefreshes, setActiveRefreshes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyApps, setBusyApps] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );

  const snapshotRequestGateRef = useRef<SnapshotRequestGate | null>(null);
  if (snapshotRequestGateRef.current === null) {
    snapshotRequestGateRef.current = new SnapshotRequestGate();
  }
  const copyTimeoutRef = useRef<number | null>(null);
  const refreshing = activeRefreshes > 0;

  const beginRefresh = useCallback(() => {
    setActiveRefreshes((current) => current + 1);
  }, []);

  const finishRefresh = useCallback(() => {
    setActiveRefreshes((current) => Math.max(0, current - 1));
  }, []);

  const beginAppOperation = useCallback((appId: string) => {
    setBusyApps((current) => {
      const next = new Map(current);
      next.set(appId, (next.get(appId) ?? 0) + 1);
      return next;
    });
  }, []);

  const finishAppOperation = useCallback((appId: string) => {
    setBusyApps((current) => {
      const next = new Map(current);
      const remaining = (next.get(appId) ?? 1) - 1;
      if (remaining > 0) next.set(appId, remaining);
      else next.delete(appId);
      return next;
    });
  }, []);

  const applyMutationSnapshot = useCallback((body: ActionResponse) => {
    if (!body.snapshot) return;

    snapshotRequestGateRef.current?.invalidate();
    setSnapshot(body.snapshot);
    setError(null);
    setLoading(false);
  }, []);

  const loadSnapshot = useCallback(
    async (quiet = false) => {
      const gate = snapshotRequestGateRef.current;
      if (!gate) return;
      const generation = gate.start(quiet);
      if (generation === null) return;
      if (!quiet) beginRefresh();

      try {
        const body = await fetchSnapshot();
        if (!gate.isCurrent(generation)) return;
        setSnapshot(body);
        setError(null);
      } catch (requestError) {
        if (!gate.isCurrent(generation)) return;
        setError(
          requestErrorMessage(requestError, "状態を取得できませんでした"),
        );
      } finally {
        if (gate.isCurrent(generation)) setLoading(false);
        gate.finish(generation);
        if (!quiet) finishRefresh();
      }
    },
    [beginRefresh, finishRefresh],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadSnapshot(true), 0);
    return () => window.clearTimeout(timeout);
  }, [loadSnapshot]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadSnapshot(true);
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [autoRefresh, loadSnapshot]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (document.querySelector(".modal[open]") && !commandOpen) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === "k"
      ) {
        event.preventDefault();
        setCommandOpen((current) => !current);
      } else if (event.key === "Escape") {
        setCommandOpen(false);
      }
    }
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [commandOpen]);

  useEffect(() => {
    if (!pendingDelete) return;
    return () => window.clearTimeout(pendingDelete.timeoutId);
  }, [pendingDelete]);

  useEffect(() => {
    return () => {
      snapshotRequestGateRef.current?.invalidate();
      if (copyTimeoutRef.current !== null)
        window.clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleAction = useCallback(
    async (app: LocalApp, action: ActionName) => {
      beginAppOperation(app.id);
      setNotice(null);
      try {
        const body = await runAppAction(app.id, action);
        applyMutationSnapshot(body);
        const warning = warningNotice(body, app.name);
        if (warning) setNotice(warning);
      } catch (requestError) {
        setNotice({
          tone: "error",
          text: requestErrorMessage(requestError, "操作に失敗しました"),
        });
        await loadSnapshot(true);
      } finally {
        finishAppOperation(app.id);
      }
    },
    [
      applyMutationSnapshot,
      beginAppOperation,
      finishAppOperation,
      loadSnapshot,
    ],
  );

  const openCreateEditor = useCallback(() => {
    setNotice(null);
    setForm(EMPTY_FORM);
    setEditorMode("create");
  }, []);

  const openEditEditor = useCallback((app: LocalApp) => {
    setNotice(null);
    setForm(definitionToForm(app.definition));
    setEditorMode("edit");
  }, []);

  const closeEditor = useCallback(() => {
    setEditorMode(null);
  }, []);

  const updateForm = useCallback(
    <K extends keyof FormState>(field: K, value: FormState[K]) => {
      setForm((current) => ({ ...current, [field]: value }));
    },
    [],
  );

  const handleSaveApp = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const editing = editorMode === "edit";
      setSaving(true);
      setNotice(null);
      try {
        const body = await saveAppDefinition(formToDefinition(form), editing);
        applyMutationSnapshot(body);
        const warning = warningNotice(body, "保存しました");
        if (warning) setNotice(warning);
        setEditorMode(null);
      } catch (requestError) {
        setNotice({
          tone: "error",
          text: requestErrorMessage(requestError, "保存に失敗しました"),
        });
      } finally {
        setSaving(false);
      }
    },
    [applyMutationSnapshot, editorMode, form],
  );

  const commitDeleteApp = useCallback(
    async (app: LocalApp) => {
      setPendingDelete((current) =>
        current?.app.id === app.id ? null : current,
      );
      beginAppOperation(app.id);
      setNotice(null);
      try {
        const body = await deleteAppDefinition(app.id);
        applyMutationSnapshot(body);
        const warning = warningNotice(body, "登録を削除しました");
        if (warning) setNotice(warning);
      } catch (requestError) {
        setNotice({
          tone: "error",
          text: requestErrorMessage(requestError, "削除に失敗しました"),
        });
        await loadSnapshot(true);
      } finally {
        finishAppOperation(app.id);
      }
    },
    [
      applyMutationSnapshot,
      beginAppOperation,
      finishAppOperation,
      loadSnapshot,
    ],
  );

  const handleDeleteApp = useCallback(
    (app: LocalApp) => {
      if (pendingDelete || busyApps.has(app.id)) return;
      const timeoutId = window.setTimeout(
        () => void commitDeleteApp(app),
        DELETE_DELAY_MS,
      );
      setPendingDelete({ app, timeoutId });
      setNotice(null);
      if (form.id === app.id) setEditorMode(null);
    },
    [busyApps, commitDeleteApp, form.id, pendingDelete],
  );

  const undoDelete = useCallback(() => {
    if (!pendingDelete) return;
    window.clearTimeout(pendingDelete.timeoutId);
    setPendingDelete(null);
  }, [pendingDelete]);

  const handleCaddySync = useCallback(async () => {
    beginRefresh();
    setNotice(null);
    try {
      const body = await syncCaddyRoutes();
      applyMutationSnapshot(body);
      const warning = warningNotice(body, "Caddyへ同期しました");
      if (warning) setNotice(warning);
    } catch (requestError) {
      setNotice({
        tone: "error",
        text: requestErrorMessage(requestError, "Caddy同期に失敗しました"),
      });
    } finally {
      finishRefresh();
    }
  }, [applyMutationSnapshot, beginRefresh, finishRefresh]);

  const handleCopy = useCallback(async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      if (copyTimeoutRef.current !== null)
        window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopied(null);
        copyTimeoutRef.current = null;
      }, COPY_NOTICE_MS);
    } catch {
      setNotice({
        tone: "error",
        text: "クリップボードへコピーできませんでした",
      });
    }
  }, []);

  const setAutoRefreshEnabled = useCallback((enabled: boolean) => {
    setAutoRefresh(enabled);
  }, []);

  const openCommandPalette = useCallback(() => {
    setCommandOpen(true);
  }, []);

  const closeCommandPalette = useCallback(() => {
    setCommandOpen(false);
  }, []);

  const mutate = useCallback(
    async (path: string, body: unknown, method = "POST") => {
      try {
        const result = await mutateDashboard(path, body, method);
        applyMutationSnapshot(result);
        return true;
      } catch (error) {
        setNotice({
          tone: "error",
          text: requestErrorMessage(error, "保存できませんでした"),
        });
        return false;
      }
    },
    [applyMutationSnapshot],
  );

  const clearNotice = useCallback(() => {
    setNotice(null);
  }, []);

  const healthLabel = useMemo(() => {
    if (!snapshot) return "状態を取得中";
    if (snapshot.summary.offline === 0) return "すべて正常";
    return `${snapshot.summary.offline} 件を確認してください`;
  }, [snapshot]);

  const visibleApps = useMemo(
    () =>
      snapshot?.apps.filter((app) => app.id !== pendingDelete?.app.id) ?? [],
    [pendingDelete?.app.id, snapshot],
  );

  const busyAppIds = useMemo(() => new Set(busyApps.keys()), [busyApps]);

  return {
    snapshot,
    mutate,
    loading,
    refreshing,
    error,
    notice,
    autoRefresh,
    copied,
    editorMode,
    form,
    saving,
    commandOpen,
    pendingDelete,
    healthLabel,
    visibleApps,
    busyAppIds,
    loadSnapshot,
    handleAction,
    openCreateEditor,
    openEditEditor,
    closeEditor,
    updateForm,
    handleSaveApp,
    handleDeleteApp,
    undoDelete,
    handleCaddySync,
    handleCopy,
    setAutoRefreshEnabled,
    openCommandPalette,
    closeCommandPalette,
    clearNotice,
  };
}

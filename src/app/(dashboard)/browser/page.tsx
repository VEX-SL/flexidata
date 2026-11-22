// /src/app/(dashboard)/browser/page.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowRight, Bot, CheckCircle2, Loader2, MessageSquare, Monitor, Plus, RefreshCw } from "lucide-react";
import { requestBrowserPageContext } from "@/lib/browser-agent/bridge";
import { useTranslation } from "@/lib/i18n";

type BrowserAgent = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  enabled_at: string | null;
};

type ConnectionState = "idle" | "checking" | "connected" | "unavailable";
type ActionError = "update" | "create" | "enableAfterCreate";

export default function BrowserAgentPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [agents, setAgents] = useState<BrowserAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busyAgent, setBusyAgent] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [connectionHost, setConnectionHost] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [actionError, setActionError] = useState<ActionError | null>(null);

  const connectionMessage =
    connection === "checking"
      ? t("browserAgent.connection.checking")
      : connection === "connected"
        ? t("browserAgent.connection.connected", { host: connectionHost })
        : connection === "unavailable"
          ? t("browserAgent.connection.unavailable")
          : t("browserAgent.connection.idle");

  const loadAgents = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch("/api/browser/settings", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setLoadError(true);
        return;
      }
      setAgents(Array.isArray(payload.agents) ? payload.agents : []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => { void loadAgents(); }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadAgents]);

  async function checkExtension() {
    setConnection("checking");
    setConnectionHost("");
    try {
      const context = await requestBrowserPageContext(5_000);
      setConnectionHost(new URL(context.url).hostname);
      setConnection("connected");
    } catch {
      setConnection("unavailable");
    }
  }

  async function setEnabled(agent: BrowserAgent, enabled: boolean) {
    setBusyAgent(agent.id);
    setActionError(null);
    try {
      const response = await fetch("/api/browser/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, enabled }),
      });
      if (!response.ok) {
        setActionError("update");
        return;
      }
      setAgents((current) => current.map((item) => item.id === agent.id
        ? { ...item, enabled, enabled_at: enabled ? new Date().toISOString() : null }
        : item));
    } catch {
      setActionError("update");
    } finally {
      setBusyAgent(null);
    }
  }

  async function createBrowserAgent() {
    const name = agentName.trim();
    if (!name || createBusy) return;
    setCreateBusy(true);
    setActionError(null);
    let createdId = "";

    try {
      const createResponse = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: t("browserAgent.agentDescription"),
        }),
      });
      const created = await createResponse.json();
      if (!createResponse.ok || typeof created.id !== "string") {
        throw new Error(t("browserAgent.errors.create"));
      }
      createdId = created.id;

      const enableResponse = await fetch("/api/browser/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: createdId, enabled: true }),
      });
      if (!enableResponse.ok) {
        throw new Error(t("browserAgent.errors.enableAfterCreate"));
      }
    } catch {
      setActionError(createdId ? "enableAfterCreate" : "create");
      void loadAgents();
      return;
    } finally {
      setCreateBusy(false);
    }

    router.push(`/agents/${createdId}/chat`);
  }

  return (
    <main className="h-full overflow-auto p-5 md:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="relative overflow-hidden rounded-3xl border border-border bg-card p-6 md:p-8">
          <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
          <div className="relative flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div className="max-w-2xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-background/70 px-3 py-1 text-xs text-muted-foreground">
                <Monitor size={14} /> FlexiData Browser Agent
              </div>
              <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{t("browserAgent.pageTitle")}</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                {t("browserAgent.pageDescription")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void checkExtension()}
              disabled={connection === "checking"}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium transition hover:bg-accent disabled:opacity-60"
            >
              {connection === "checking" ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              {t("browserAgent.checkConnection")}
            </button>
          </div>
          <div className={`relative mt-5 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${connection === "connected" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300" : connection === "unavailable" ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300" : "border-border bg-background/60 text-muted-foreground"}`}>
            {connection === "connected" ? <CheckCircle2 size={17} className="mt-0.5 shrink-0" /> : connection === "unavailable" ? <AlertCircle size={17} className="mt-0.5 shrink-0" /> : <Monitor size={17} className="mt-0.5 shrink-0" />}
            <span>{connectionMessage}</span>
          </div>
        </header>

        <section className="rounded-3xl border border-border bg-card p-5 md:p-6">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{t("browserAgent.agentsTitle")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("browserAgent.agentsDescription")}</p>
            </div>
            <button
              type="button"
              onClick={() => { setShowCreate((value) => !value); setActionError(null); }}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              <Plus size={16} /> {t("browserAgent.createAgent")}
            </button>
          </div>

          {showCreate && (
            <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4 sm:flex-row">
              <input
                value={agentName}
                onChange={(event) => setAgentName(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void createBrowserAgent(); }}
                placeholder={t("browserAgent.agentNamePlaceholder")}
                aria-label={t("browserAgent.agentNameAria")}
                className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary"
                maxLength={80}
              />
              <button
                type="button"
                onClick={() => void createBrowserAgent()}
                disabled={!agentName.trim() || createBusy}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {createBusy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                {t("browserAgent.createAndEnable")}
              </button>
            </div>
          )}

          {actionError && <p role="alert" className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{t(`browserAgent.errors.${actionError}`)}</p>}

          {loading ? (
            <div className="flex min-h-32 items-center justify-center text-muted-foreground"><Loader2 size={22} className="animate-spin" /></div>
          ) : loadError ? (
            <div className="rounded-2xl border border-destructive/25 bg-destructive/5 p-4 text-sm text-destructive">
              <p>{t("browserAgent.errors.load")}</p>
              <button onClick={() => void loadAgents()} className="mt-3 underline">{t("browserAgent.retry")}</button>
            </div>
          ) : agents.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border px-5 py-10 text-center">
              <Bot size={28} className="mx-auto text-muted-foreground" />
              <p className="mt-3 font-medium">{t("browserAgent.emptyTitle")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t("browserAgent.emptyDescription")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {agents.map((agent) => (
                <article key={agent.id} className="flex flex-col gap-4 rounded-2xl border border-border bg-background/50 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Bot size={20} /></div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate font-semibold">{agent.name}</h3>
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${agent.enabled ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}>
                          {agent.enabled ? t("browserAgent.enabledBadge") : t("browserAgent.disabledBadge")}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{agent.description || t("browserAgent.noDescription")}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void setEnabled(agent, !agent.enabled)}
                      disabled={busyAgent === agent.id}
                      aria-pressed={agent.enabled}
                      className={`inline-flex min-w-28 items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition disabled:opacity-60 ${agent.enabled ? "border-border bg-background hover:bg-accent" : "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"}`}
                    >
                      {busyAgent === agent.id ? <Loader2 size={15} className="animate-spin" /> : null}
                      {agent.enabled ? t("browserAgent.disable") : t("browserAgent.enable")}
                    </button>
                    <button
                      type="button"
                      onClick={() => router.push(`/agents/${agent.id}/chat`)}
                      className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                    >
                      <MessageSquare size={15} /> {t("browserAgent.openChat")}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="rounded-2xl border border-border bg-muted/30 p-4 text-xs leading-5 text-muted-foreground">
          <strong className="text-foreground">{t("browserAgent.privacyTitle")}</strong> {t("browserAgent.privacyDescription")}
        </aside>
      </div>
    </main>
  );
}
import type { EmbyDeletionSettings, EmbyDeletionStatus } from "@mdcz/shared/embyDeletion";
import type { ServerApiContract } from "@mdcz/shared/serverApi";
import {
  Button,
  Checkbox,
  copyText,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mdcz/ui";
import { useEffect, useId, useState } from "react";
import { useT } from "../../i18n";

export function EmbyDeletionPanel({ service }: { service: ServerApiContract["embyDeletion"] & { origin: string } }) {
  const text = useT().settings.embyDeletion;
  const id = useId();
  const [status, setStatus] = useState<EmbyDeletionStatus | null>(null);
  const [draft, setDraft] = useState<EmbyDeletionSettings>({ mode: "off", serverId: "", libraryIds: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let closed = false;
    const load = async (initial = false) => {
      try {
        const result = await service.status();
        if (closed) return;
        setStatus(result);
        if (initial) setDraft(result.settings);
        setError(null);
      } catch (cause) {
        if (!closed) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load(true);
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [service]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-border/60 p-4">
      <div>
        <div className="text-sm font-medium">{text.title}</div>
        <p className="mt-1 text-xs text-muted-foreground">{text.description}</p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
      {!status ? (
        <p className="text-sm text-muted-foreground">{text.loading}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const { token } = await service.rotateSecret();
                  setUrl(`${service.origin}/api/webhooks/emby/${token}`);
                  setStatus(await service.status());
                })
              }
            >
              {status.configured ? text.rotate : text.generate}
            </Button>
            <span className="text-xs text-muted-foreground">{text.secretHint}</span>
          </div>
          {url ? (
            <div className="space-y-2">
              <Input aria-label={text.address} readOnly value={url} />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  void run(async () => {
                    await copyText(url);
                    setMessage(text.copied);
                  })
                }
              >
                {text.copy}
              </Button>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor={`${id}-server`} className="text-sm">
                {text.serverId}
              </label>
              <Input
                id={`${id}-server`}
                value={draft.serverId}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, serverId: event.target.value })}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${id}-mode`} className="text-sm">
                {text.mode}
              </label>
              <Select
                disabled={busy}
                value={draft.mode}
                onValueChange={(mode: EmbyDeletionSettings["mode"]) => setDraft({ ...draft, mode })}
              >
                <SelectTrigger id={`${id}-mode`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["off", "observe", "delete"] as const).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {text.modes[mode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <fieldset disabled={busy} className="space-y-2">
            <legend className="mb-2 text-sm">{text.libraries}</legend>
            {!status.libraries.length ? (
              <p className="text-xs text-muted-foreground">{text.noLibraries}</p>
            ) : (
              status.libraries.map((library) => (
                <label key={library.id} htmlFor={`${id}-${library.id}`} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={`${id}-${library.id}`}
                    checked={draft.libraryIds.includes(library.id)}
                    onCheckedChange={(checked) =>
                      setDraft({
                        ...draft,
                        libraryIds: checked
                          ? [...new Set([...draft.libraryIds, library.id])]
                          : draft.libraryIds.filter((value) => value !== library.id),
                      })
                    }
                  />
                  <span>
                    {library.name}
                    <span className="ml-2 break-all text-xs text-muted-foreground">{library.outputPath}</span>
                  </span>
                </label>
              ))
            )}
          </fieldset>
          <p className="text-xs text-muted-foreground">{text.scopeHint}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await service.configure(draft);
                  setStatus(result);
                  setDraft(result.settings);
                  setMessage(text.saved);
                })
              }
            >
              {text.save}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || status.settings.mode === "off"}
              onClick={() =>
                void run(async () => {
                  const result = await service.reconcile();
                  setMessage(text.queued(result.queued));
                  setStatus(await service.status());
                })
              }
            >
              {text.reconcile}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {text.counts(
              status.counts.pending,
              status.counts.completed,
              status.counts.ignored,
              status.counts.needs_review,
            )}
          </p>
          {!status.recent.length ? (
            <p className="text-xs text-muted-foreground">{text.noEvents}</p>
          ) : (
            <ul className="max-h-64 space-y-2 overflow-auto text-xs">
              {status.recent.map((event) => (
                <li key={event.id} className="space-y-1 rounded-lg bg-muted/40 p-2">
                  <div>
                    {new Date(event.receivedAt).toLocaleString()} · {text.states[event.status]}
                  </div>
                  <div>{text.sender(event.serverId)}</div>
                  <div className="break-all">{event.path ?? text.noPath}</div>
                  <div className="text-muted-foreground">
                    {text.results[event.result as keyof typeof text.results] ?? event.result}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

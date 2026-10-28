import { toErrorMessage } from "@mdcz/shared/error";
import { formatBytes } from "@mdcz/shared/format";
import type { ScrapeConflictInput, ScrapeConflictPreview } from "@mdcz/shared/scrapeConflict";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@mdcz/ui";
import { useState } from "react";
import type { DetailActionPort } from "../adapters/ports";
import { useT } from "../i18n";

export function ScrapeConflictDialog({ input, port }: { input: ScrapeConflictInput; port: DetailActionPort }) {
  const t = useT();
  const text = t.scrape.conflict;
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ScrapeConflictPreview | null>(null);
  const [keep, setKeep] = useState<"existing" | "incoming" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);

  const load = async () => {
    if (!port.previewConflict || busy) return;
    setOpen(true);
    setBusy(true);
    setError("");
    setPreview(null);
    setKeep(null);
    try {
      const result = await port.previewConflict(input);
      setPreview(result);
      setKeep(result.keep);
      if (result.step === "completed") setCompleted(true);
    } catch (error) {
      setError(toErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const resolve = async () => {
    if (!preview || !keep || !port.resolveConflict || busy) return;
    setBusy(true);
    setError("");
    try {
      await port.resolveConflict({ ...input, token: preview.token, keep });
      setCompleted(true);
      setOpen(false);
    } catch (error) {
      setError(toErrorMessage(error));
      setPreview({ ...preview, keep });
    } finally {
      setBusy(false);
    }
  };
  if (!port.previewConflict || !port.resolveConflict) return null;

  return (
    <div className="space-y-3">
      {completed ? (
        <p role="status" className="text-sm text-muted-foreground">
          {text.completed}
        </p>
      ) : (
        <Button variant="outline" onClick={() => void load()}>
          {text.open}
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{text.title}</DialogTitle>
            <DialogDescription>{text.description}</DialogDescription>
          </DialogHeader>
          {busy ? (
            <p role="status" className="text-sm text-muted-foreground">
              {preview ? text.deleting : text.loading}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="whitespace-pre-wrap break-all text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {preview ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {(["existing", "incoming"] as const).map((side) => {
                  const version = preview[side];
                  return (
                    <label
                      key={side}
                      className="flex cursor-pointer flex-col gap-3 rounded-lg border p-4 has-checked:border-primary has-checked:bg-primary/5"
                    >
                      <span className="flex items-center gap-2 font-medium">
                        <input
                          type="radio"
                          name={`keep-${input.itemId}`}
                          value={side}
                          checked={keep === side}
                          disabled={busy || Boolean(preview.keep)}
                          onChange={() => setKeep(side)}
                        />
                        {side === "existing" ? text.keepExisting : text.keepIncoming}
                      </span>
                      <span className="break-all text-sm">{version.name}</span>
                      <strong className="text-xl tabular-nums">
                        {formatBytes(version.size, { fractionDigits: 2 })}
                      </strong>
                      <dl className="space-y-2 break-all text-xs text-muted-foreground">
                        <div>
                          <dt>{text.cloud}</dt>
                          <dd>{version.cloudPath}</dd>
                        </div>
                        <div>
                          <dt>Normal STRM</dt>
                          <dd>{version.normalPath}</dd>
                        </div>
                        {version.linkPath ? (
                          <div>
                            <dt>Link STRM</dt>
                            <dd>{version.linkPath}</dd>
                          </div>
                        ) : null}
                      </dl>
                    </label>
                  );
                })}
              </div>
              {preview.sameResource ? <p className="text-sm text-muted-foreground">{text.sameResource}</p> : null}
              {keep ? (
                <div className="space-y-2 rounded-lg bg-destructive/5 p-3 text-sm">
                  <p className="font-medium">{text.willDelete}</p>
                  <p className="break-all">{preview[keep === "existing" ? "incoming" : "existing"].name}</p>
                  <p>{keep === "existing" ? text.deleteIncoming : text.deleteExisting}</p>
                  {!preview.sameResource ? <p>{text.deleteCloud}</p> : null}
                </div>
              ) : null}
            </>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              {t.common.cancel}
            </Button>
            {!preview ? (
              <Button disabled={busy} onClick={() => void load()}>
                {t.common.retry}
              </Button>
            ) : (
              <Button variant="destructive" disabled={busy || !keep || completed} onClick={() => void resolve()}>
                {text.confirm}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

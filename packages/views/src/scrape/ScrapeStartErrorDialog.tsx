import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@mdcz/ui";
import type { DetailActionPort } from "../adapters/ports";
import { useT } from "../i18n";
import { selectScrapeResults, useScrapeStore } from "../state/scrapeStore";
import { ScrapeConflictDialog } from "./ScrapeConflictDialog";

export function ScrapeStartErrorDialog({
  error,
  onClose,
  port,
}: {
  error: unknown;
  onClose(): void;
  port?: DetailActionPort;
}) {
  const t = useT();
  const results = useScrapeStore(selectScrapeResults);
  const message = (
    error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message
      : String(error ?? "")
  )
    .replace(/^Error invoking remote method '[^']+':\s*/u, "")
    .trim();

  return (
    <Dialog open={error !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t.scrape.incompleteTitle}</DialogTitle>
          <DialogDescription>{t.scrape.incompleteDesc}</DialogDescription>
        </DialogHeader>
        <div role="alert" className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs">
          {message}
        </div>
        {port
          ? results
              .filter((item) => item.conflict && item.taskId && message.includes(item.conflict.sourcePath))
              .map((item) => (
                <div key={item.fileId} className="space-y-2">
                  <p className="break-all text-sm">{item.fileName}</p>
                  <ScrapeConflictDialog input={{ taskId: item.taskId ?? "", itemId: item.fileId }} port={port} />
                </div>
              ))
          : null}
        <DialogFooter>
          <Button onClick={onClose}>{t.scrape.understood}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { toErrorMessage } from "@mdcz/shared/error";
import type { SubtitleJobErrorType } from "@mdcz/shared/subtitleJobs";
import {
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
} from "@mdcz/ui";
import { useT } from "@mdcz/views/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { api } from "./client";
import { queryKeys } from "./lib/queryKeys";

export function SubtitleBatchRetry({ disabled, onQueued }: { disabled: boolean; onQueued: () => void }) {
  const t = useT();
  const labels = t.pending.subtitleQueue;
  const client = useQueryClient();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [types, setTypes] = useState<SubtitleJobErrorType[] | null>(null);
  const [selection, setSelection] = useState(new Map<string, number>());
  const failures = useQuery({
    queryKey: [...queryKeys.subtitleJobs, "failures"],
    queryFn: () => api.subtitleUpdates.listFailed(),
    enabled: open,
  });
  const jobs = failures.data ?? [];
  const counts = new Map<SubtitleJobErrorType, number>();
  for (const { errorType } of jobs) counts.set(errorType, (counts.get(errorType) ?? 0) + 1);
  const errorTypes = (Object.keys(labels.errorTypes) as SubtitleJobErrorType[]).filter((type) => counts.has(type));
  const includedTypes = types ?? errorTypes;
  const keyword = search.trim().toLowerCase();
  const matched = jobs.filter(
    ({ errorType, mediaPath }) => includedTypes.includes(errorType) && mediaPath.toLowerCase().includes(keyword),
  );
  const selected = matched.filter(({ taskId, attempts }) => selection.get(taskId) === attempts);
  const selectedTypes = errorTypes.filter((type) => includedTypes.includes(type)).length;
  const retry = useMutation({
    mutationFn: api.subtitleUpdates.retryBatch,
    onSuccess: ({ queued }, { jobs }) => {
      setOpen(false);
      onQueued();
      void client.invalidateQueries({ queryKey: queryKeys.subtitleJobs });
      if (queued === jobs.length) toast.success(labels.retryQueued(queued));
      else toast.info(labels.retryChanged(queued, jobs.length - queued));
    },
  });
  const error = retry.error ?? failures.error;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (retry.isPending) return;
        if (next) {
          setSearch("");
          setTypes(null);
          setSelection(new Map());
          retry.reset();
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <RotateCcw className="size-4" />
          {labels.batchRetry}
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{labels.batchRetry}</DialogTitle>
          <DialogDescription>{labels.batchRetryDescription}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto">
          {failures.isLoading ? <p role="status">{t.common.loading}</p> : null}
          {error ? (
            <p role="alert" className="break-words text-sm text-destructive">
              {toErrorMessage(error)}
            </p>
          ) : null}
          {failures.data ? (
            <>
              <Input
                type="search"
                aria-label={labels.search}
                placeholder={labels.search}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                disabled={retry.isPending}
              />
              <fieldset disabled={retry.isPending} className="space-y-2 text-sm">
                <legend className="mb-2 font-semibold">{labels.filterTypes}</legend>
                <label htmlFor={`${id}-all-types`} className="flex cursor-pointer items-center gap-2">
                  <Checkbox
                    id={`${id}-all-types`}
                    checked={selectedTypes > 0 && (selectedTypes === errorTypes.length || "indeterminate")}
                    disabled={!errorTypes.length}
                    onCheckedChange={(checked) => setTypes(checked ? null : [])}
                  />
                  {labels.allErrorTypes}
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {errorTypes.map((type) => (
                    <label key={type} htmlFor={`${id}-type-${type}`} className="flex cursor-pointer items-center gap-2">
                      <Checkbox
                        id={`${id}-type-${type}`}
                        checked={includedTypes.includes(type)}
                        onCheckedChange={(checked) =>
                          setTypes(checked ? [...includedTypes, type] : includedTypes.filter((value) => value !== type))
                        }
                      />
                      {labels.errorTypes[type]} ({counts.get(type)})
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset disabled={retry.isPending} className="min-w-0 space-y-2 border-t pt-3 text-sm">
                <p role="status" className="font-semibold">
                  {labels.retryCounts(matched.length, selected.length)}
                </p>
                <label htmlFor={`${id}-all-jobs`} className="flex cursor-pointer items-center gap-2">
                  <Checkbox
                    id={`${id}-all-jobs`}
                    checked={selected.length > 0 && (selected.length === matched.length || "indeterminate")}
                    disabled={!matched.length}
                    onCheckedChange={(checked) =>
                      setSelection(
                        checked ? new Map(matched.map(({ taskId, attempts }) => [taskId, attempts])) : new Map(),
                      )
                    }
                  />
                  {labels.allMatches}
                </label>
                {matched.length ? (
                  <ul className="max-h-52 divide-y overflow-y-auto rounded-md border">
                    {matched.map(({ taskId, attempts, mediaPath, errorType }) => (
                      <li key={taskId}>
                        <label
                          htmlFor={`${id}-job-${taskId}`}
                          className="flex cursor-pointer items-center gap-2 px-3 py-2"
                        >
                          <Checkbox
                            id={`${id}-job-${taskId}`}
                            checked={selection.get(taskId) === attempts}
                            onCheckedChange={(checked) =>
                              setSelection((current) => {
                                const next = new Map(current);
                                if (checked) next.set(taskId, attempts);
                                else next.delete(taskId);
                                return next;
                              })
                            }
                          />
                          <span className="min-w-0 break-all">
                            {mediaPath}
                            <span className="block text-xs text-muted-foreground">{labels.errorTypes[errorType]}</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">{labels.noMatches}</p>
                )}
              </fieldset>
            </>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={retry.isPending}>
              {t.common.cancel}
            </Button>
          </DialogClose>
          <Button
            disabled={!selected.length || retry.isPending || failures.isFetching || failures.isError}
            onClick={() => retry.mutate({ jobs: selected.map(({ taskId, attempts }) => ({ taskId, attempts })) })}
          >
            {retry.isPending ? t.pending.submitting : labels.submitRetry}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

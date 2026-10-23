import { cn } from "@mdcz/ui";
import { type ReactNode, useCallback } from "react";
import { useOptionalSettingsSearch } from "./SettingsSearchContext";

type SettingRowLayout = "horizontal" | "vertical";

interface SettingRowProps {
  fieldName?: string;
  label: string;
  description?: string;
  htmlFor?: string;
  labelAddon?: ReactNode;
  headerAction?: ReactNode;
  control: ReactNode;
  error?: string | null;
  className?: string;
  controlClassName?: string;
  layout?: SettingRowLayout;
  /** When true, apply a subtle highlight to indicate this row matches the current search. */
  highlighted?: boolean;
}

export function SettingRow({
  fieldName,
  label,
  description,
  htmlFor,
  labelAddon,
  headerAction,
  control,
  error,
  className,
  controlClassName,
  layout = "horizontal",
  highlighted,
}: SettingRowProps) {
  const search = useOptionalSettingsSearch();
  const registerFieldNode = useCallback(
    (node: HTMLDivElement | null) => {
      if (!search || !fieldName) {
        return;
      }

      search.registerFieldNode(fieldName, node);
    },
    [fieldName, search],
  );

  const isVerticalLayout = layout === "vertical";

  return (
    <div
      ref={fieldName ? registerFieldNode : undefined}
      data-field-name={fieldName}
      className={cn(
        "group/setting-row border-b border-border/40 py-5 transition-colors duration-150 sm:py-6",
        isVerticalLayout ? "flex flex-col gap-3" : "grid min-w-0 grid-cols-1 items-start gap-3 md:grid-cols-2 md:gap-8",
        highlighted && "border-l-2 border-l-primary/80 pl-3 -ml-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-h-6 items-center gap-2">
          <label htmlFor={htmlFor} className="block min-h-6 font-numeric text-sm font-medium leading-6 text-foreground">
            {label}
          </label>
          {labelAddon ? <div className="flex h-6 shrink-0 items-center">{labelAddon}</div> : null}
          {headerAction ? <div className="flex h-6 shrink-0 items-center">{headerAction}</div> : null}
        </div>
        {description && <p className="mt-1.5 max-w-prose text-sm leading-6 text-muted-foreground">{description}</p>}
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
      {isVerticalLayout ? (
        <div className="flex flex-col gap-2">
          <div data-setting-control className={controlClassName}>
            {control}
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 items-center justify-end gap-2.5">
          <div
            data-setting-control
            className={cn(
              "min-w-0 max-w-full has-[input:not([type=checkbox])]:w-full has-[textarea]:w-full has-[[data-slot=select-trigger]]:w-full [&_input]:w-full [&_textarea]:w-full [&_[data-slot=select-trigger]]:w-full",
              controlClassName,
            )}
          >
            {control}
          </div>
        </div>
      )}
    </div>
  );
}

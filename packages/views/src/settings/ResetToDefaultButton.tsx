import { Button, cn } from "@mdcz/ui";
import { RotateCcw } from "lucide-react";
import { useT } from "../i18n";

interface ResetToDefaultButtonProps {
  label: string;
  onClick: () => void;
  className?: string;
  showLabel?: boolean;
}

export function ResetToDefaultButton({ label, onClick, className, showLabel = false }: ResetToDefaultButtonProps) {
  const t = useT();
  return (
    <Button
      type="button"
      variant="ghost"
      size={showLabel ? "sm" : "icon-xs"}
      aria-label={t.settings.resetToDefault.ariaLabel(label)}
      title={t.settings.resetToDefault.title}
      onClick={onClick}
      className={cn(
        "h-6 rounded-[var(--radius-quiet-capsule)] text-muted-foreground hover:text-foreground",
        showLabel
          ? "gap-1 px-2 text-xs"
          : "w-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/setting-row:opacity-100 group-focus-within/setting-row:opacity-100",
        className,
      )}
    >
      <RotateCcw className="h-3.5 w-3.5" />
      {showLabel && t.settings.resetToDefault.title}
    </Button>
  );
}

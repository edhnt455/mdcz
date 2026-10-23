import { cn } from "@mdcz/ui";
import { type ReactNode, useContext } from "react";
import { CrossFieldBanner } from "./CrossFieldBanner";
import { SettingsNavigationContext } from "./SettingsNavigationContext";
import { useOptionalSettingsSearch } from "./SettingsSearchContext";
import { type FieldEntry, isFieldAnchor } from "./settingsRegistry";
import { useCrossFieldErrors } from "./useCrossFieldErrors";

interface SectionAnchorProps {
  id: string;
  label: string;
  title?: string;
  description?: string;
  className?: string;
  children: ReactNode;
}

export function SectionAnchor({ id, label, title, description, className, children }: SectionAnchorProps) {
  const activeSection = useContext(SettingsNavigationContext);
  const search = useOptionalSettingsSearch();
  if (isFieldAnchor(id) && search && !search.isAnchorVisible(id)) return null;

  const isBrowsingCategory = activeSection !== null && !search?.hasActiveFilters;

  return (
    <section
      id={`settings-${id}`}
      aria-label={title ?? label}
      hidden={isBrowsingCategory && activeSection !== id}
      className={className}
    >
      {(title || description) && (
        <header className={cn("mb-5", isBrowsingCategory && !description && "sr-only")}>
          {title && <h2 className="font-numeric text-lg font-semibold tracking-tight text-foreground">{title}</h2>}
          {description && <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{description}</p>}
        </header>
      )}
      {isFieldAnchor(id) && <SectionBanner sectionKey={id} />}
      <div>{children}</div>
    </section>
  );
}

function SectionBanner({ sectionKey }: { sectionKey: FieldEntry["anchor"] }) {
  const errors = useCrossFieldErrors(sectionKey);
  return <CrossFieldBanner errors={errors} />;
}

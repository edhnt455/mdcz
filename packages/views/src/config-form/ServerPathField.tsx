import { FormControl } from "@mdcz/ui";
import type { ControllerRenderProps, FieldValues } from "react-hook-form";
import { PathAutocompleteInput } from "../path";
import { useSettingsServices } from "../settings/SettingsServices";

interface ServerPathFieldProps {
  field: ControllerRenderProps<FieldValues, string>;
  label?: string;
  description?: string;
  placeholder?: string;
  isDirectory?: boolean;
}

export function ServerPathField({ field, placeholder, isDirectory = true }: ServerPathFieldProps) {
  const services = useSettingsServices();
  const kind = isDirectory ? "directory" : "file";
  const suggestions = services.getPathSuggestions?.(kind) ?? [];
  const suggestDirectoryPath = services.suggestDirectoryPath;

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex items-center gap-2 w-full justify-end">
        <FormControl>
          <PathAutocompleteInput
            value={String(field.value ?? "")}
            placeholder={placeholder}
            staticSuggestions={suggestions}
            loadSuggestions={
              isDirectory && suggestDirectoryPath ? async (value) => await suggestDirectoryPath(value) : undefined
            }
            inputClassName="h-8 text-sm bg-background/50 focus:bg-background transition-all flex-1"
            onBlur={field.onBlur}
            onChange={field.onChange}
          />
        </FormControl>
      </div>
    </div>
  );
}

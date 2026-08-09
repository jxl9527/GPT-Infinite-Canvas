import type { ChangeEvent } from "react";
import {
  encodeCanvasObjectValue,
  type CanvasObjectGroup
} from "./canvas-object-navigation";

interface CanvasObjectNavigatorProps {
  value: string;
  groups: readonly CanvasObjectGroup[];
  onChange: (value: string) => void;
}

export function CanvasObjectNavigator({ value, groups, onChange }: CanvasObjectNavigatorProps) {
  const objectCount = groups.reduce((total, group) => total + group.options.length, 0);
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value);

  return (
    <section className="canvas-object-navigator" aria-label="画布对象导航">
      <label htmlFor="canvas-object-select">画布对象</label>
      <select
        id="canvas-object-select"
        value={value}
        onChange={handleChange}
        aria-describedby="canvas-object-summary"
      >
        <option value="">未选择</option>
        {groups.map((group) => group.options.length > 0 && (
          <optgroup key={group.label} label={`${group.label}（${group.options.length}）`}>
            {group.options.map((option) => (
              <option
                key={encodeCanvasObjectValue(option.kind, option.id)}
                value={encodeCanvasObjectValue(option.kind, option.id)}
              >
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span id="canvas-object-summary">共 {objectCount} 个可选择对象</span>
    </section>
  );
}

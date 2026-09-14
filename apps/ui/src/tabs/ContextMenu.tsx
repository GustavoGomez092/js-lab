import { useEffect, useRef, useState } from "react";

export interface MenuEntry {
  id: string;
  label: string;
  disabled?: boolean;
  run(): void;
}

export function ContextMenu(props: { x: number; y: number; items: MenuEntry[]; onClose(): void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: props.x, top: props.y });

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) props.onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    // Keep the menu inside the viewport: a click near the right or bottom edge would otherwise
    // open it partly off-screen.
    const rect = menu.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.max(0, Math.min(props.x, window.innerWidth - rect.width));
      const top = Math.max(0, Math.min(props.y, window.innerHeight - rect.height));
      if (left !== props.x || top !== props.y) setPosition({ left, top });
    }
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [props.onClose, props.x, props.y]);

  return (
    <div ref={menu} className="context-menu" role="menu" style={{ left: position.left, top: position.top }}>
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            props.onClose();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

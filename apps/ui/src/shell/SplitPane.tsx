import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";

export function SplitPane(props: {
  orientation: "horizontal" | "vertical";
  size: number;
  secondVisible: boolean;
  onResize(size: number): void;
  onReset(): void;
  first: ReactNode;
  second: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const horizontal = props.orientation === "horizontal";
  // As built (M1 T18 fix round): the attached drag listeners, so an unmount mid-drag (before pointerup) removes them too.
  const activeDrag = useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);

  useEffect(() => {
    return () => {
      if (activeDrag.current) {
        window.removeEventListener("pointermove", activeDrag.current.move);
        window.removeEventListener("pointerup", activeDrag.current.up);
        activeDrag.current = null;
      }
    };
  }, []);

  const startDrag = (event: ReactPointerEvent) => {
    event.preventDefault();
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return;
    const move = (e: PointerEvent) => {
      const ratio = horizontal ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
      props.onResize(Math.round(ratio * 100));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      activeDrag.current = null;
    };
    activeDrag.current = { move, up };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!props.secondVisible) {
    return (
      <div ref={container} className={`split split-${props.orientation}`}>
        <div className="split-pane split-pane-rest">{props.first}</div>
      </div>
    );
  }

  return (
    <div ref={container} className={`split split-${props.orientation}`}>
      <div className="split-pane" style={{ flexBasis: `${props.size}%` }}>
        {props.first}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable splitter needs role=separator; <hr> cannot be dragged */}
      <div
        className="split-divider"
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-valuenow={props.size}
        aria-valuemin={10}
        aria-valuemax={90}
        tabIndex={0}
        onPointerDown={startDrag}
        onDoubleClick={props.onReset}
        onKeyDown={(event) => {
          const step = { ArrowLeft: -2, ArrowUp: -2, ArrowRight: 2, ArrowDown: 2 }[event.key] ?? 0;
          if (step !== 0) props.onResize(props.size + step);
          if (event.key === "Enter") props.onReset();
        }}
      />
      <div className="split-pane split-pane-rest">{props.second}</div>
    </div>
  );
}

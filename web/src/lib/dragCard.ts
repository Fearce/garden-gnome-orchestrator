import type { CSSProperties, HTMLAttributes } from "react";

/** What a board card needs to take part in drag-to-reorder. Task cards and Co-work cards take the same
 *  props, so the board's sortable wrapper and drag overlay never branch on which kind they hold. */
export interface DragCardProps {
  innerRef?: (el: HTMLElement | null) => void;
  style?: CSSProperties;
  dragging?: boolean;
  draggableCard?: boolean;
  dragProps?: HTMLAttributes<HTMLElement>;
}

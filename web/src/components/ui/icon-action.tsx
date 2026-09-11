import * as Tooltip from "@radix-ui/react-tooltip";
import { Button, type ButtonProps } from "./button";

export const TooltipProvider = Tooltip.Provider;

export function IconAction({
  label,
  hint,
  children,
  ...props
}: ButtonProps & { label: string; hint?: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="detail-icon-action"
          aria-label={label}
          {...props}
        >
          {children}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="action-tooltip"
          side="bottom"
          sideOffset={10}
          collisionPadding={12}
        >
          <strong>{label}</strong>
          {hint && <span>{hint}</span>}
          <Tooltip.Arrow
            className="action-tooltip-arrow"
            width={10}
            height={5}
          />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

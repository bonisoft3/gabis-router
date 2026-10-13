import React, { useState } from 'react';
import { InfoButton } from '../TooltipPopover.tsx';

interface CollapsibleDetailsProps {
  id?: string;
  className?: string;
  summaryClassName?: string;
  title: string;
  tooltip?: string;
  tooltipAriaLabel?: string;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  children: React.ReactNode;
}

export const CollapsibleDetails: React.FC<CollapsibleDetailsProps> = ({
  id,
  className = 'ri-details',
  summaryClassName = 'ri-details-summary',
  title,
  tooltip,
  tooltipAriaLabel,
  defaultOpen = true,
  onToggle,
  children,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const handleToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const nextOpen = (e.currentTarget as HTMLDetailsElement).open;
    setIsOpen(nextOpen);
    onToggle?.(nextOpen);
  };

  return (
    <details id={id} className={className} open={isOpen} onToggle={handleToggle}>
      <summary className={summaryClassName}>
        {title}
        {tooltip && <InfoButton tooltip={tooltip} ariaLabel={tooltipAriaLabel} />}
      </summary>
      {isOpen && children}
    </details>
  );
};

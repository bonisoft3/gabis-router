import React, { useState, useEffect, useRef } from 'react';

interface PopoverState {
  text: string;
  x: number;
  y: number;
}

export const PopoverContext = React.createContext<{
  showTooltip: (btn: HTMLElement, text: string) => void;
  hideTooltip: (btn?: HTMLElement) => void;
  togglePinTooltip: (btn: HTMLElement, text: string) => void;
}>({
  showTooltip: () => {},
  hideTooltip: () => {},
  togglePinTooltip: () => {},
});

export const PopoverProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const activeBtnRef = useRef<HTMLElement | null>(null);
  const isPinnedRef = useRef<boolean>(false);

  const openForButton = (btn: HTMLElement, text: string) => {
    activeBtnRef.current = btn;
    const btnRect = btn.getBoundingClientRect();
    // Default estimated position before DOM measurement
    let left = btnRect.left + btnRect.width / 2 - 120;
    left = Math.max(8, Math.min(window.innerWidth - 248, left));
    let top = btnRect.top - 60;
    if (top < 8) {
      top = btnRect.bottom + 8;
    }
    setPopover({ text, x: left, y: top });
  };

  const dismissAll = () => {
    isPinnedRef.current = false;
    setPopover(null);
    if (activeBtnRef.current) {
      activeBtnRef.current.classList.remove('active');
      activeBtnRef.current = null;
    }
  };

  const showTooltip = (btn: HTMLElement, text: string) => {
    if (isPinnedRef.current) return;
    openForButton(btn, text);
  };

  const hideTooltip = (btn?: HTMLElement) => {
    if (isPinnedRef.current) return;
    if (btn && activeBtnRef.current && activeBtnRef.current !== btn) return;
    dismissAll();
  };

  const togglePinTooltip = (btn: HTMLElement, text: string) => {
    if (isPinnedRef.current && activeBtnRef.current === btn) {
      dismissAll();
      return;
    }
    if (activeBtnRef.current && activeBtnRef.current !== btn) {
      activeBtnRef.current.classList.remove('active');
    }
    isPinnedRef.current = true;
    btn.classList.add('active');
    openForButton(btn, text);
  };

  // Adjust exact positioning after render
  useEffect(() => {
    if (popover && popoverRef.current && activeBtnRef.current) {
      const popRect = popoverRef.current.getBoundingClientRect();
      const btnRect = activeBtnRef.current.getBoundingClientRect();

      let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
      left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, left));

      let top = btnRect.top - popRect.height - 8;
      if (top < 8) {
        top = btnRect.bottom + 8;
      }

      popoverRef.current.style.left = `${left}px`;
      popoverRef.current.style.top = `${top}px`;
    }
  }, [popover]);

  // Click outside to dismiss
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (!popover) return;
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (activeBtnRef.current?.contains(target)) return;
      dismissAll();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissAll();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [popover]);

  return (
    <PopoverContext.Provider value={{ showTooltip, hideTooltip, togglePinTooltip }}>
      {children}
      {popover && (
        <div
          id="info-popover"
          ref={popoverRef}
          role="tooltip"
          style={{ left: `${popover.x}px`, top: `${popover.y}px` }}
        >
          {popover.text}
        </div>
      )}
    </PopoverContext.Provider>
  );
};

export const InfoButton: React.FC<{ tooltip: string; ariaLabel?: string }> = ({
  tooltip,
  ariaLabel,
}) => {
  const { showTooltip, hideTooltip, togglePinTooltip } = React.useContext(PopoverContext);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const handlePointerEnter = () => {
    if (!btnRef.current) return;
    showTooltip(btnRef.current, tooltip);
  };

  const handlePointerLeave = () => {
    if (!btnRef.current) return;
    hideTooltip(btnRef.current);
  };

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!btnRef.current) return;
    togglePinTooltip(btnRef.current, tooltip);
  };

  return (
    <button
      ref={btnRef}
      type="button"
      className="info-btn"
      data-tooltip={tooltip}
      aria-label={ariaLabel || 'Information'}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onClick={handleClick}
    >
      i
    </button>
  );
};

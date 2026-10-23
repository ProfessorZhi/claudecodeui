import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListOrdered } from 'lucide-react';

import InputOutlineHandle from '@/modules/chat/outline/InputOutlineHandle';
import { useOutlineHandleDrag } from '@/modules/chat/outline/useOutlineHandleDrag';
import type { InputOutlineEntry } from '@/modules/chat/outline/useInputOutline';

type InputOutlineDrawerProps = {
  entries: InputOutlineEntry[];
  /** Mobile anchors the handle from the bottom edge and keeps the panel inside a narrow screen. */
  isMobile: boolean;
  /** The shared jump from `useChatSessionState`, addressed by transcript anchor id. */
  onJump: (anchorId: string) => void;
};

/**
 * Rendered by ChatInterface (desktop and mobile) as a right-edge drawer listing the
 * session's user inputs; picking one jumps the transcript to it. The handle,
 * panel and backdrop follow the retired quick-settings drawer.
 */
export default function InputOutlineDrawer({ entries, isMobile, onJump }: InputOutlineDrawerProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const { isDragging, handleStyle, startDrag, consumeSuppressedClick } = useOutlineHandleDrag({ isMobile });

  const handleToggleFromHandle = useCallback(() => {
    // A drag that ends over the handle still fires a click; it must not toggle.
    if (consumeSuppressedClick()) return;
    setIsOpen((previous) => !previous);
  }, [consumeSuppressedClick]);

  const handleJump = useCallback((anchorId: string) => {
    setIsOpen(false);
    onJump(anchorId);
  }, [onJump]);

  return (
    <>
      <InputOutlineHandle
        isOpen={isOpen}
        isMobile={isMobile}
        isDragging={isDragging}
        style={handleStyle}
        onClick={handleToggleFromHandle}
        onMouseDown={startDrag}
        onTouchStart={startDrag}
      />

      <div
        className={`fixed right-0 top-0 z-[9999] h-full w-64 max-w-[85vw] transform border-l border-border bg-background shadow-xl transition-transform duration-150 ease-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
        aria-hidden={!isOpen}
        data-input-outline-panel
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-border bg-muted/40 p-4">
            <h3 className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <ListOrdered className="h-5 w-5 text-muted-foreground" />
              {t('inputOutline.title')}
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto">
            {entries.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">{t('inputOutline.empty')}</p>
            ) : (
              <ol className="py-1">
                {entries.map((entry, index) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      tabIndex={isOpen ? 0 : -1}
                      onClick={() => handleJump(entry.id)}
                      className="flex w-full items-baseline gap-2 px-4 py-2 text-left text-sm text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                      title={entry.preview}
                      data-input-outline-entry={entry.id}
                    >
                      <span className="w-6 flex-shrink-0 text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                      <span className="line-clamp-2 min-w-0 break-words">{entry.preview || t('inputOutline.untitled')}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-[9998] bg-background/80 backdrop-blur-sm transition-opacity duration-150 ease-out"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
}

import { Activity, AlertTriangle, CircleSlash, HelpCircle, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { QuayDriverState } from '@/shared/types';
import { cn } from '@/shared/utils';

type QuayIndicatorSize = 'xs' | 'sm' | 'md' | 'lg';

type QuayIndicatorProps = {
  /** Tier-1 reading; when false the indicator renders nothing at all. */
  hasQuayConfig: boolean;
  /** Tier-2 driver reading for the selected project; defaults to `idle` when unknown. */
  status?: QuayDriverState;
  size?: QuayIndicatorSize;
  className?: string;
  showLabel?: boolean;
};

type QuayIndicatorConfig = {
  icon: LucideIcon;
  colorClassName: string;
  backgroundClassName: string;
  label: string;
  title: string;
};

const sizeClassNames: Record<QuayIndicatorSize, string> = {
  xs: 'w-3 h-3',
  sm: 'w-4 h-4',
  md: 'w-5 h-5',
  lg: 'w-6 h-6',
};

const paddingClassNames: Record<QuayIndicatorSize, string> = {
  xs: 'p-0.5',
  sm: 'p-1',
  md: 'p-1.5',
  lg: 'p-2',
};

const getIndicatorConfig = (status: QuayDriverState): QuayIndicatorConfig => {
  if (status === 'running') {
    return {
      icon: Zap,
      colorClassName: 'text-green-500 dark:text-green-400',
      backgroundClassName: 'bg-green-50 dark:bg-green-950',
      label: 'quay running',
      title: 'quay configured, driver running',
    };
  }

  if (status === 'stale') {
    return {
      icon: AlertTriangle,
      colorClassName: 'text-amber-500 dark:text-amber-400',
      backgroundClassName: 'bg-amber-50 dark:bg-amber-950',
      label: 'quay stale',
      title: 'quay configured, driver not alive',
    };
  }

  if (status === 'idle') {
    return {
      icon: Activity,
      colorClassName: 'text-blue-500 dark:text-blue-400',
      backgroundClassName: 'bg-blue-50 dark:bg-blue-950',
      label: 'quay idle',
      title: 'quay configured, driver idle',
    };
  }

  // A failed read is "no reading" (grey, question mark), not a reading that says
  // something is wrong (amber, `stale`) and not a project without quay at all.
  if (status === 'unavailable') {
    return {
      icon: HelpCircle,
      colorClassName: 'text-gray-400 dark:text-gray-500',
      backgroundClassName: 'bg-gray-50 dark:bg-gray-900',
      label: 'quay unknown',
      title: 'quay configured, driver status unavailable',
    };
  }

  return {
    icon: CircleSlash,
    colorClassName: 'text-gray-400 dark:text-gray-500',
    backgroundClassName: 'bg-gray-50 dark:bg-gray-900',
    label: 'No quay',
    title: 'quay not configured',
  };
};

/**
 * Rendered by SidebarProjectItem beside TaskIndicator to show whether a project
 * has quay configured. Mirrors TaskIndicator's icon + status-colour + tooltip
 * language; it renders nothing for a project without a `.quay/config.yml`, so a
 * non-quay project's sidebar row is visually unchanged.
 */
export default function QuayIndicator({
  hasQuayConfig,
  status = 'idle',
  size = 'sm',
  className = '',
  showLabel = false,
}: QuayIndicatorProps) {
  if (!hasQuayConfig) {
    return null;
  }

  const indicatorConfig = getIndicatorConfig(status);
  const Icon = indicatorConfig.icon;

  if (showLabel) {
    return (
      <div
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
          indicatorConfig.backgroundClassName,
          indicatorConfig.colorClassName,
          className,
        )}
        title={indicatorConfig.title}
        data-quay-indicator={status}
      >
        <Icon className={sizeClassNames[size]} />
        <span className="font-normal">{indicatorConfig.label}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'inline-flex items-center justify-center rounded-full transition-colors',
        indicatorConfig.backgroundClassName,
        paddingClassNames[size],
        className,
      )}
      title={indicatorConfig.title}
      data-quay-indicator={status}
    >
      <Icon className={cn(sizeClassNames[size], indicatorConfig.colorClassName)} />
    </div>
  );
}

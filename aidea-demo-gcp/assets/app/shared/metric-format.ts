/** Shared display contract: ratio/% values are fractions; calculations stay unchanged. */
export function formatMetricValue(value: number | null, unit = ''): string {
  if (value === null) return '暂无数据';
  const percentage = unit === '%' || unit === 'ratio';
  const formatted = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(percentage ? value * 100 : value);
  return percentage ? `${formatted}%` : `${formatted}${unit ? ` ${unit}` : ''}`;
}

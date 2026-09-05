export default function JournalBadge({ info }) {
  if (!info) return null
  const parts = []
  if (info.impact_factor != null) parts.push(`IF ${info.impact_factor}`)
  if (info.cas_zone) parts.push(`中科院${info.cas_zone}区${info.cas_top ? ' Top' : ''}`)
  if (!parts.length && !(info.warn_years?.length)) return null
  const tip = [
    info.name,
    info.jcr_quartile ? `JCR ${info.jcr_quartile}` : null,
    info.impact_factor != null ? `影响因子 ${info.impact_factor}（JCR ${info.jcr_year}）` : null,
    info.cas_zone ? `中科院${info.cas_zone}区${info.cas_top ? ' Top' : ''}（${info.cas_year} 升级版）` : null,
    info.jcr_category || null,
  ].filter(Boolean).join(' · ')
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {parts.length > 0 && (
        <span className="jbadge" title={tip}>📊 {parts.join(' · ')}</span>
      )}
      {info.warn_years?.length > 0 && (
        <span className="jbadge jbadge-warn"
          title={`中科院《国际期刊预警名单》：${info.warn_years.map(w => `${w.year} 年${w.info ? `（${w.info}）` : ''}`).join('、')}`}>
          ⚠ 预警期刊
        </span>
      )}
    </span>
  )
}

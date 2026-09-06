import Icon from './Icon'

// 统一空态模板：图标 + 标题 + 提示 + 操作按钮
export default function EmptyState({ icon = 'inbox', title, hint, children }) {
  return (
    <div className="empty-state">
      <div className="empty-ico"><Icon name={icon} size={30} /></div>
      <div className="empty-title">{title}</div>
      {hint && <div className="muted" style={{ fontSize: 13.5 }}>{hint}</div>}
      {children && <div className="row" style={{ marginTop: 14, justifyContent: 'center', flexWrap: 'wrap' }}>{children}</div>}
    </div>
  )
}

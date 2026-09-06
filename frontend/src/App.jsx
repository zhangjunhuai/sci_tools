import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'

const NAVS = [
  { to: '/', label: '文献库', icon: '📚', end: true },
  { to: '/projects', label: '项目', icon: '📁' },
  { to: '/feed', label: 'arXiv 订阅', icon: '📰' },
  { to: '/graph', label: '知识图谱', icon: '🕸' },
  { to: '/settings', label: '设置', icon: '⚙️' },
]

export default function App() {
  // 黑色全局导航栏收起/展开（记住上次状态）
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem('nav_collapsed') === '1')

  useEffect(() => {
    localStorage.setItem('nav_collapsed', navCollapsed ? '1' : '0')
  }, [navCollapsed])

  return (
    <div className={`layout ${navCollapsed ? 'nav-collapsed' : ''}`}>
      <nav className="sidebar">
        <button className="nav-toggle" onClick={() => setNavCollapsed(v => !v)}
          title={navCollapsed ? '展开导航' : '收起导航'}>
          {navCollapsed ? '»' : '«'}
        </button>
        <div className="logo" title="科研文献中心">{navCollapsed ? '📚' : '📚 文献中心'}</div>
        {NAVS.map(n => (
          <NavLink key={n.to} to={n.to} end={n.end} title={navCollapsed ? n.label : undefined}>
            <span className="nav-icon">{n.icon}</span>
            {!navCollapsed && <span>{n.label}</span>}
          </NavLink>
        ))}
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import Icon from './components/Icon'

const NAVS = [
  { to: '/', label: '文献库', icon: 'book', end: true },
  { to: '/projects', label: '项目', icon: 'folder' },
  { to: '/feed', label: '订阅', icon: 'rss' },
  { to: '/graph', label: '知识图谱', icon: 'network' },
  { to: '/settings', label: '设置', icon: 'settings' },
]

export default function App() {
  // 黑色全局导航栏收起/展开（记住上次状态）
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem('nav_collapsed') === '1')
  // 深色模式
  const [dark, setDark] = useState(() => (localStorage.getItem('theme') || 'light') === 'dark')

  useEffect(() => {
    localStorage.setItem('nav_collapsed', navCollapsed ? '1' : '0')
  }, [navCollapsed])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])

  return (
    <div className={`layout ${navCollapsed ? 'nav-collapsed' : ''}`}>
      <nav className="sidebar">
        <div className="nav-toggle-row">
          <button className="nav-toggle" onClick={() => setNavCollapsed(v => !v)}
            title={navCollapsed ? '展开导航' : '收起导航'}>
            {navCollapsed ? '»' : '«'}
          </button>
        </div>
        <div className="logo" title="科研文献中心">
          <Icon name="book" size={18} />
          {!navCollapsed && <span>文献中心</span>}
        </div>
        {NAVS.map(n => (
          <NavLink key={n.to} to={n.to} end={n.end} title={navCollapsed ? n.label : undefined}>
            <span className="nav-icon"><Icon name={n.icon} size={16} /></span>
            {!navCollapsed && <span>{n.label}</span>}
          </NavLink>
        ))}
        <div style={{ marginTop: 'auto' }}>
          <button className="nav-theme-btn" onClick={() => setDark(v => !v)}
            title={dark ? '切换浅色模式' : '切换深色模式'}>
            <Icon name={dark ? 'sun' : 'moon'} size={16} />
            {!navCollapsed && <span>深色模式</span>}
          </button>
        </div>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}

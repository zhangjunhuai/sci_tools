import { NavLink, Outlet } from 'react-router-dom'

export default function App() {
  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="logo">📚 文献中心</div>
        <NavLink to="/" end>文献库</NavLink>
        <NavLink to="/projects">项目</NavLink>
        <NavLink to="/feed">arXiv 订阅</NavLink>
        <NavLink to="/graph">知识图谱</NavLink>
        <NavLink to="/settings">设置</NavLink>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}

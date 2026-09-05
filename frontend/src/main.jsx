import React from 'react'
import ReactDOM from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import App from './App'
import Library from './pages/Library'
import PaperDetail from './pages/PaperDetail'
import Feed from './pages/Feed'
import Settings from './pages/Settings'
import Graph from './pages/Graph'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import './styles.css'

const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Library /> },
      { path: 'papers/:id', element: <PaperDetail /> },
      { path: 'feed', element: <Feed /> },
      { path: 'graph', element: <Graph /> },
      { path: 'projects', element: <Projects /> },
      { path: 'projects/:id', element: <ProjectDetail /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
])

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
)

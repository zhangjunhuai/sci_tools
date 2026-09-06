import { useRef, useState } from 'react'
import Icon from './Icon'
import { createPortal } from 'react-dom'

// 悬浮提示：portal 渲染到 body + fixed 定位，避免被任何 overflow 容器裁剪
export default function Tip({ text }) {
  const iconRef = useRef(null)
  const [pos, setPos] = useState(null)

  function onScroll() {
    window.removeEventListener('scroll', onScroll, true)
    setPos(null)
  }

  function show() {
    const r = iconRef.current?.getBoundingClientRect()
    if (!r) return
    const width = Math.min(300, window.innerWidth - 16)
    let left = r.left + r.width / 2 - width / 2
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    // 默认显示在图标上方；上方空间不足时翻到下方
    const place = r.top > 130 ? 'above' : 'below'
    window.removeEventListener('scroll', onScroll, true)
    window.addEventListener('scroll', onScroll, true)
    setPos({
      left,
      width,
      place,
      y: place === 'above' ? window.innerHeight - r.top + 8 : r.bottom + 8,
    })
  }

  function hide() {
    window.removeEventListener('scroll', onScroll, true)
    setPos(null)
  }

  const popup = pos
    ? createPortal(
        <div
          className="tip-pop-fixed"
          style={{
            left: pos.left,
            width: pos.width,
            ...(pos.place === 'above' ? { bottom: pos.y } : { top: pos.y }),
          }}
        >
          {text}
        </div>,
        document.body
      )
    : null

  return (
    <span className="tip-wrap" onMouseEnter={show} onMouseLeave={hide}>
      <span ref={iconRef} className="tip-icon"><Icon name="info" size={13} /></span>
      {popup}
    </span>
  )
}

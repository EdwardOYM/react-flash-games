import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { games } from '../games'
import { getPreferredLocale, useTranslations } from '../assets/languages'

function ScenePreview({ previewAlt }: { previewAlt: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    const shape = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 1), new THREE.MeshStandardMaterial({ color: 0xffc857, flatShading: true }))
    scene.add(shape)
    scene.add(new THREE.AmbientLight(0xfff1c1, 2.2))
    camera.position.z = 4
    const resize = () => { const { clientWidth, clientHeight } = canvas; renderer.setSize(clientWidth, clientHeight, false); camera.aspect = clientWidth / clientHeight; camera.updateProjectionMatrix() }
    let frame = 0
    const animate = (time: number) => { shape.rotation.x = time * 0.0004; shape.rotation.y = time * 0.0007; renderer.render(scene, camera); frame = requestAnimationFrame(animate) }
    resize()
    frame = requestAnimationFrame(animate)
    window.addEventListener('resize', resize)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize); shape.geometry.dispose(); shape.material.dispose(); renderer.dispose() }
  }, [])

  return <canvas ref={canvasRef} aria-label={previewAlt} />
}

export function StartPage() {
  const t = useTranslations(getPreferredLocale())

  return <main className="start-page"><header className="topbar"><div className="brand"><span className="brand-mark">FG</span><span>{t('brand')}</span></div><span className="status">{t('status')}</span></header><section className="intro"><div className="intro-copy"><p className="eyebrow">{t('eyebrow')}</p><h1>{t('headlineStart')}<br /><em>{t('headlineEmphasis')}</em></h1><p className="lede">{t('description')}</p><div className="game-list">{games.map((game) => <button className="game-row" key={game.id} type="button"><span>{game.icon}</span><span>{t(game.titleKey)}</span><small>{t(game.statusKey)}</small></button>)}</div></div><div className="preview"><ScenePreview previewAlt={t('previewAlt')} /><span className="preview-label">{t('previewLabel')}</span></div></section></main>
}
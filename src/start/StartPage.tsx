import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { games } from '../games'

function ScenePreview() {
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

  return <canvas ref={canvasRef} aria-label="Animated game preview" />
}

export function StartPage() {
  return <main className="start-page"><header className="topbar"><div className="brand"><span className="brand-mark">FG</span><span>Flash Games</span></div><span className="status">three.js playground</span></header><section className="intro"><div className="intro-copy"><p className="eyebrow">Quick rounds. Bright ideas.</p><h1>Pick a game.<br /><em>Make it count.</em></h1><p className="lede">A home for tiny experiments, reflex tests, and games that respect your time.</p><div className="game-list">{games.map((game) => <button className="game-row" key={game.id} type="button"><span>{game.icon}</span><span>{game.title}</span><small>{game.status}</small></button>)}</div></div><div className="preview"><ScenePreview /><span className="preview-label">LIVE / 001</span></div></section></main>
}